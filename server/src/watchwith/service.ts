import { eq } from 'drizzle-orm';
import { decryptSecret } from '../crypto.js';
import { db } from '../db/index.js';
import { media, users } from '../db/schema.js';
import { getSectionItems, getSections, isWatchedOnPlex } from '../plex/client.js';
import { getServerAccessToken } from '../plex/plextv.js';
import { getPlexConfig } from '../settings.js';
import { getRecentWatchedIds, getWatchedSet } from '../trakt/service.js';

// Per-person watch history, best source available:
//   1. Trakt (user connected their account)
//   2. Their own Plex account (they signed in with Plex; we query the server with their token)
//   3. The sync account's watch flags (last resort)
export type WatchedMethod = 'trakt' | 'plex' | 'sync-account';

// A person's own Plex history: media id → when they last watched it (epoch
// ms), or null when Plex didn't say.
type PlexWatched = Map<number, number | null>;

const plexWatchedCache = new Map<number, { at: number; watched: PlexWatched }>();
const CACHE_MS = 5 * 60_000;

async function plexWatched(userId: number, plexToken: string): Promise<PlexWatched | null> {
  const cached = plexWatchedCache.get(userId);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.watched;
  const cfg = getPlexConfig();
  if (!cfg) return null;

  const rows = db
    .select({ id: media.id, ratingKey: media.ratingKey })
    .from(media)
    .where(eq(media.source, 'plex'))
    .all();
  const byKey = new Map(rows.map((r) => [r.ratingKey, r.id]));

  const watched: PlexWatched = new Map();
  try {
    // Same server, but queried with the user's token, so UserData is theirs.
    // Shared users need their per-server token — the server rejects their account token.
    const serverToken = await getServerAccessToken(cfg, plexToken);
    if (!serverToken) return null; // server no longer shared with them
    const sections = (await getSections(cfg.url, serverToken)).filter(
      (s) => s.type === 'movie' || s.type === 'show',
    );
    for (const section of sections) {
      const items = await getSectionItems(cfg.url, serverToken, section.key);
      for (const item of items) {
        if (!isWatchedOnPlex(item)) continue;
        const id = byKey.get(item.ratingKey);
        if (id) watched.set(id, item.lastViewedAt ? item.lastViewedAt * 1000 : null);
      }
    }
  } catch {
    return null; // their token may have expired — fall through to the next method
  }

  plexWatchedCache.set(userId, { at: Date.now(), watched });
  return watched;
}

function ownPlexToken(userId: number): string | null {
  const user = db.select({ plexToken: users.plexToken }).from(users).where(eq(users.id, userId)).get();
  return user?.plexToken ? decryptSecret(user.plexToken) : null;
}

export async function watchedSetForUser(userId: number): Promise<{ set: Set<number>; method: WatchedMethod }> {
  const traktSet = getWatchedSet(userId);
  if (traktSet) return { set: traktSet, method: 'trakt' };

  const token = ownPlexToken(userId);
  if (token) {
    const watched = await plexWatched(userId, token);
    if (watched) return { set: new Set(watched.keys()), method: 'plex' };
  }

  const rows = db.select({ id: media.id }).from(media).where(eq(media.watched, true)).all();
  return { set: new Set(rows.map((r) => r.id)), method: 'sync-account' };
}

// Up to `limit` media ids the person watched most recently, newest first, from
// the same sources in the same order as watchedSetForUser. The sync account's
// flags carry no times, so without Trakt or Plex history there's nothing to give.
export async function recentlyWatchedForUser(userId: number, limit: number): Promise<{ mediaIds: number[]; method: WatchedMethod }> {
  const fromTrakt = getRecentWatchedIds(userId, limit);
  if (fromTrakt.length) return { mediaIds: fromTrakt, method: 'trakt' };

  const token = ownPlexToken(userId);
  if (token) {
    const watched = await plexWatched(userId, token);
    if (watched) {
      const mediaIds = [...watched]
        .filter((entry): entry is [number, number] => entry[1] !== null)
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([id]) => id);
      return { mediaIds, method: 'plex' };
    }
  }
  return { mediaIds: [], method: 'sync-account' };
}

// plex.tv Discover watchlist for one account.
// Overridable so tests can point it at a fake Discover service.
const DISCOVER = process.env.PLEX_DISCOVER_URL ?? 'https://discover.provider.plex.tv';
const WATCHLIST_PAGE_SIZE = 100;
const WATCHLIST_MAX = 2000;

export interface WatchlistItem {
  title: string;
  year: number | null;
  type: string;
  guids: string[];
}

// plex.tv hands a watchlist out a page at a time; keep asking until it's all here.
export async function fetchWatchlist(token: string): Promise<WatchlistItem[]> {
  const items: WatchlistItem[] = [];
  for (let start = 0; start < WATCHLIST_MAX; start += WATCHLIST_PAGE_SIZE) {
    const url = new URL('library/sections/watchlist/all', `${DISCOVER}/`);
    url.searchParams.set('includeGuids', '1');
    const res = await fetch(url, {
      headers: {
        'X-Plex-Token': token,
        Accept: 'application/json',
        'X-Plex-Container-Start': String(start),
        'X-Plex-Container-Size': String(WATCHLIST_PAGE_SIZE),
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`plex.tv watchlist request failed (${res.status})`);
    const json = (await res.json()) as {
      MediaContainer?: {
        totalSize?: number;
        Metadata?: { title: string; year?: number; type?: string; Guid?: { id: string }[] }[];
      };
    };
    const page = json.MediaContainer?.Metadata ?? [];
    for (const m of page) {
      items.push({ title: m.title, year: m.year ?? null, type: m.type ?? 'movie', guids: (m.Guid ?? []).map((g) => g.id) });
    }
    if (page.length < WATCHLIST_PAGE_SIZE || items.length >= (json.MediaContainer?.totalSize ?? 0)) break;
  }
  return items;
}

// Stable identity for intersecting two watchlists: external id first, title+year fallback.
export function watchlistKey(item: WatchlistItem): string {
  const ext =
    item.guids.find((g) => g.startsWith('imdb://')) ?? item.guids.find((g) => g.startsWith('tmdb://'));
  return ext ?? `t:${item.title.toLowerCase()}|${item.year ?? ''}`;
}
