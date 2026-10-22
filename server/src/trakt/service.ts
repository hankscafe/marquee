import { and, desc, eq, isNotNull } from 'drizzle-orm';
import { decryptSecret, encryptSecret } from '../crypto.js';
import { db } from '../db/index.js';
import { media, users, userWatched } from '../db/schema.js';
import { logger } from '../logger.js';
import { getTraktApp, getWatched, refreshAccessToken, TraktAuthError, type TraktWatched } from './client.js';

// Pull the user's watched movies/shows from Trakt and match them against the
// synced library by IMDb/TMDb id. Replaces the user's user_watched rows.
export async function refreshUserWatched(userId: number): Promise<number> {
  const app = getTraktApp();
  if (!app) throw new Error('Trakt is not configured — ask your admin');
  const user = db.select().from(users).where(eq(users.id, userId)).get();
  if (!user?.traktToken) throw new Error('Trakt is not connected');

  const fetchAll = (token: string) =>
    Promise.all([getWatched(app.clientId, token, 'movies'), getWatched(app.clientId, token, 'shows')]);

  let movies: TraktWatched[];
  let shows: TraktWatched[];
  try {
    [movies, shows] = await fetchAll(decryptSecret(user.traktToken));
  } catch (err) {
    // Expired access token: refresh once and retry.
    if (!(err instanceof TraktAuthError) || !user.traktRefresh) throw err;
    const renewed = await refreshAccessToken(app.clientId, app.clientSecret, decryptSecret(user.traktRefresh));
    db.update(users)
      .set({ traktToken: encryptSecret(renewed.accessToken), traktRefresh: encryptSecret(renewed.refreshToken) })
      .where(eq(users.id, userId))
      .run();
    logger.info({ userId }, 'refreshed expired trakt token');
    [movies, shows] = await fetchAll(renewed.accessToken);
  }

  // id → when it was last watched. Trakt may leave the time out, so whether a
  // title was watched is has(), never the value.
  const byId = (list: TraktWatched[]) => {
    const imdb = new Map<string, string | null>();
    const tmdb = new Map<string, string | null>();
    for (const entry of list) {
      if (entry.ids.imdb) imdb.set(entry.ids.imdb, entry.lastWatchedAt);
      if (entry.ids.tmdb != null) tmdb.set(String(entry.ids.tmdb), entry.lastWatchedAt);
    }
    return { imdb, tmdb };
  };
  const movieIds = byId(movies);
  const showIds = byId(shows);

  const rows = db
    .select({ id: media.id, type: media.type, imdbId: media.imdbId, tmdbId: media.tmdbId })
    .from(media)
    .all();
  const matched: { id: number; watchedAt: Date | null }[] = [];
  for (const r of rows) {
    const ids = r.type === 'movie' ? movieIds : showIds;
    const at =
      r.imdbId && ids.imdb.has(r.imdbId)
        ? ids.imdb.get(r.imdbId)!
        : r.tmdbId && ids.tmdb.has(r.tmdbId)
          ? ids.tmdb.get(r.tmdbId)!
          : undefined;
    if (at !== undefined) matched.push({ id: r.id, watchedAt: at ? new Date(at) : null });
  }

  db.transaction((tx) => {
    tx.delete(userWatched).where(eq(userWatched.userId, userId)).run();
    for (const m of matched) {
      tx.insert(userWatched).values({ userId, mediaId: m.id, watchedAt: m.watchedAt }).onConflictDoNothing().run();
    }
  });

  return matched.length;
}

// Trakt history is matched to the titles in the library at the time, so after a
// library sync every connected user is matched again — titles that just arrived
// count as watched too. One user at a time; a failure only skips that user.
export async function refreshAllTraktWatched(): Promise<void> {
  if (!getTraktApp()) return;
  const connected = db.select({ id: users.id }).from(users).where(isNotNull(users.traktToken)).all();
  for (const { id } of connected) {
    try {
      await refreshUserWatched(id);
    } catch (err) {
      logger.warn({ userId: id, err: err instanceof Error ? err.message : String(err) }, 'trakt refresh after sync failed');
    }
  }
}

// The user's personal watched set, or null when Trakt has nothing to say —
// not connected, or connected with no history matched yet (say, the first
// import failed). Callers then fall through to the next source.
export function getWatchedSet(userId: number): Set<number> | null {
  const user = db.select({ traktToken: users.traktToken }).from(users).where(eq(users.id, userId)).get();
  if (!user?.traktToken) return null;
  const rows = db
    .select({ mediaId: userWatched.mediaId })
    .from(userWatched)
    .where(eq(userWatched.userId, userId))
    .all();
  if (!rows.length) return null;
  return new Set(rows.map((r) => r.mediaId));
}

// The user's most recently watched media ids per Trakt, newest first — empty
// when they haven't connected it. Rows without a time aren't guessed at.
export function getRecentWatchedIds(userId: number, limit: number): number[] {
  const user = db.select({ traktToken: users.traktToken }).from(users).where(eq(users.id, userId)).get();
  if (!user?.traktToken) return [];
  return db
    .select({ mediaId: userWatched.mediaId })
    .from(userWatched)
    .where(and(eq(userWatched.userId, userId), isNotNull(userWatched.watchedAt)))
    .orderBy(desc(userWatched.watchedAt))
    .limit(limit)
    .all()
    .map((r) => r.mediaId);
}
