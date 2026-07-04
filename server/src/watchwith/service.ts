import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { media, users } from '../db/schema.js';
import { getSectionItems, getSections } from '../plex/client.js';
import { getPlexConfig } from '../settings.js';
import { getWatchedSet } from '../trakt/service.js';

// Per-person watch history, best source available:
//   1. Trakt (user connected their account)
//   2. Their own Plex account (they signed in with Plex; we query the server with their token)
//   3. The sync account's watch flags (last resort)
export type WatchedMethod = 'trakt' | 'plex' | 'sync-account';

const plexWatchedCache = new Map<number, { at: number; set: Set<number> }>();
const CACHE_MS = 5 * 60_000;

async function plexWatchedSet(userId: number, plexToken: string): Promise<Set<number> | null> {
  const cached = plexWatchedCache.get(userId);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.set;
  const cfg = getPlexConfig();
  if (!cfg) return null;

  const rows = db
    .select({ id: media.id, ratingKey: media.ratingKey })
    .from(media)
    .where(eq(media.source, 'plex'))
    .all();
  const byKey = new Map(rows.map((r) => [r.ratingKey, r.id]));

  const set = new Set<number>();
  try {
    // Same server, but queried with the user's token, so UserData is theirs.
    const sections = (await getSections(cfg.url, plexToken)).filter(
      (s) => s.type === 'movie' || s.type === 'show',
    );
    for (const section of sections) {
      const items = await getSectionItems(cfg.url, plexToken, section.key);
      for (const item of items) {
        const watched =
          item.type === 'show'
            ? (item.leafCount ?? 0) > 0 && (item.viewedLeafCount ?? 0) >= (item.leafCount ?? 0)
            : (item.viewCount ?? 0) > 0;
        if (!watched) continue;
        const id = byKey.get(item.ratingKey);
        if (id) set.add(id);
      }
    }
  } catch {
    return null; // their token may have expired — fall through to the next method
  }

  plexWatchedCache.set(userId, { at: Date.now(), set });
  return set;
}

export async function watchedSetForUser(userId: number): Promise<{ set: Set<number>; method: WatchedMethod }> {
  const traktSet = getWatchedSet(userId);
  if (traktSet) return { set: traktSet, method: 'trakt' };

  const user = db.select({ plexToken: users.plexToken }).from(users).where(eq(users.id, userId)).get();
  if (user?.plexToken) {
    const set = await plexWatchedSet(userId, user.plexToken);
    if (set) return { set, method: 'plex' };
  }

  const rows = db.select({ id: media.id }).from(media).where(eq(media.watched, true)).all();
  return { set: new Set(rows.map((r) => r.id)), method: 'sync-account' };
}

// plex.tv Discover watchlist for one account.
export interface WatchlistItem {
  title: string;
  year: number | null;
  type: string;
  guids: string[];
}

export async function fetchWatchlist(token: string): Promise<WatchlistItem[]> {
  const url = new URL('https://discover.provider.plex.tv/library/sections/watchlist/all');
  url.searchParams.set('includeGuids', '1');
  const res = await fetch(url, { headers: { 'X-Plex-Token': token, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`plex.tv watchlist request failed (${res.status})`);
  const json = (await res.json()) as {
    MediaContainer?: { Metadata?: { title: string; year?: number; type?: string; Guid?: { id: string }[] }[] };
  };
  return (json.MediaContainer?.Metadata ?? []).map((m) => ({
    title: m.title,
    year: m.year ?? null,
    type: m.type ?? 'movie',
    guids: (m.Guid ?? []).map((g) => g.id),
  }));
}

// Stable identity for intersecting two watchlists: external id first, title+year fallback.
export function watchlistKey(item: WatchlistItem): string {
  const ext =
    item.guids.find((g) => g.startsWith('imdb://')) ?? item.guids.find((g) => g.startsWith('tmdb://'));
  return ext ?? `t:${item.title.toLowerCase()}|${item.year ?? ''}`;
}
