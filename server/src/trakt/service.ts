import { eq } from 'drizzle-orm';
import { decryptSecret, encryptSecret } from '../crypto.js';
import { db } from '../db/index.js';
import { media, users, userWatched } from '../db/schema.js';
import { logger } from '../logger.js';
import { getTraktApp, getWatched, refreshAccessToken, TraktAuthError, type TraktIds } from './client.js';

// Pull the user's watched movies/shows from Trakt and match them against the
// synced library by IMDb/TMDb id. Replaces the user's user_watched rows.
export async function refreshUserWatched(userId: number): Promise<number> {
  const app = getTraktApp();
  if (!app) throw new Error('Trakt is not configured — ask your admin');
  const user = db.select().from(users).where(eq(users.id, userId)).get();
  if (!user?.traktToken) throw new Error('Trakt is not connected');

  const fetchAll = (token: string) =>
    Promise.all([getWatched(app.clientId, token, 'movies'), getWatched(app.clientId, token, 'shows')]);

  let movies: TraktIds[];
  let shows: TraktIds[];
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

  const idSets = (list: TraktIds[]) => ({
    imdb: new Set(list.map((i) => i.imdb).filter(Boolean) as string[]),
    tmdb: new Set(list.map((i) => (i.tmdb != null ? String(i.tmdb) : null)).filter(Boolean) as string[]),
  });
  const movieIds = idSets(movies);
  const showIds = idSets(shows);

  const rows = db
    .select({ id: media.id, type: media.type, imdbId: media.imdbId, tmdbId: media.tmdbId })
    .from(media)
    .all();
  const matched = rows.filter((r) => {
    const ids = r.type === 'movie' ? movieIds : showIds;
    return (r.imdbId && ids.imdb.has(r.imdbId)) || (r.tmdbId && ids.tmdb.has(r.tmdbId));
  });

  db.transaction((tx) => {
    tx.delete(userWatched).where(eq(userWatched.userId, userId)).run();
    for (const m of matched) {
      tx.insert(userWatched).values({ userId, mediaId: m.id }).onConflictDoNothing().run();
    }
  });

  return matched.length;
}

// The user's personal watched set, or null when they haven't connected Trakt
// (callers then fall back to the Plex-account-level watched flag).
export function getWatchedSet(userId: number): Set<number> | null {
  const user = db.select({ traktToken: users.traktToken }).from(users).where(eq(users.id, userId)).get();
  if (!user?.traktToken) return null;
  const rows = db
    .select({ mediaId: userWatched.mediaId })
    .from(userWatched)
    .where(eq(userWatched.userId, userId))
    .all();
  return new Set(rows.map((r) => r.mediaId));
}
