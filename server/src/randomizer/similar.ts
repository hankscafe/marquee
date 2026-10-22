import { inArray } from 'drizzle-orm';
import type { SimilarToRecentInfo, SimilarToRecentStatus } from '@marquee/shared';
import { db } from '../db/index.js';
import { media } from '../db/schema.js';
import { logger } from '../logger.js';
import { getSeerrConfig, similarTmdbIds as seerrSimilarIds, type SeerrConfig } from '../seerr/client.js';
import type { DedupeFields, Deduped } from '../sources/dedupe.js';
import { mapLimit } from '../sources/mapLimit.js';
import { getTmdbKey, getSimilarIds as tmdbSimilarIds } from '../tmdb/client.js';
import { recentlyWatchedForUser } from '../watchwith/service.js';

// "Like what I've been watching": narrow a draw to library titles that are
// recommended for, or similar to, the person's own most recent watches.

export const SEED_COUNT_DEFAULT = 5;
export const SEED_COUNT_MAX = 10;
// Two lookups per seed; a few at a time so a spin doesn't arrive as a burst.
const CONCURRENCY = 3;

// Where suggestions come from: TMDb itself when a key is set, otherwise
// Overseerr/Jellyseerr, which pass TMDb's lists through. Ombi has no equivalent.
type Source = { name: 'tmdb'; key: string } | { name: 'seerr'; cfg: SeerrConfig };

function suggestionSource(): Source | 'not-configured' | 'unsupported' {
  const key = getTmdbKey();
  if (key) return { name: 'tmdb', key };
  const cfg = getSeerrConfig();
  if (!cfg) return 'not-configured';
  if (cfg.kind === 'ombi') return 'unsupported';
  return { name: 'seerr', cfg };
}

// What a title is similar to barely changes, and every spin seeds from the
// same recent watches, so suggestions are kept for an hour.
const CACHE_MS = 60 * 60_000;
const CACHE_MAX = 500;
const cache = new Map<string, { at: number; tmdbIds: number[] }>();

// Called when the TMDb key or request service changes.
export function clearSuggestionCache() {
  cache.clear();
}

async function suggestionsFor(source: Source, type: 'movie' | 'show', tmdbId: number): Promise<number[]> {
  const key = `${source.name}:${type}:${tmdbId}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.tmdbIds;
  const tmdbType = type === 'show' ? 'tv' : 'movie';
  const tmdbIds =
    source.name === 'tmdb' ? await tmdbSimilarIds(tmdbType, tmdbId, source.key) : await seerrSimilarIds(source.cfg, tmdbType, tmdbId);
  // Insertion order is age order, so the first key is the oldest.
  if (!cache.has(key) && cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
  cache.set(key, { at: Date.now(), tmdbIds });
  return tmdbIds;
}

// Keep the pool whenever the narrowing can't be trusted — a filter that can
// silently empty the library would make Spin fail for reasons nobody can act
// on — and say why in the status.
const skipped = (status: SimilarToRecentStatus, seedCount = 0): SimilarToRecentInfo => ({ status, seedCount, matchCount: 0 });

export async function narrowToSimilar<T extends DedupeFields>(
  pool: Deduped<T>[],
  viewerId: number,
  seedCount: number,
): Promise<{ pool: Deduped<T>[]; info: SimilarToRecentInfo }> {
  const keep = (info: SimilarToRecentInfo) => ({ pool, info });
  const source = suggestionSource();
  if (typeof source === 'string') return keep(skipped(source));

  const { mediaIds } = await recentlyWatchedForUser(viewerId, seedCount);
  const seeds = mediaIds.length
    ? db
        .select({ type: media.type, tmdbId: media.tmdbId })
        .from(media)
        .where(inArray(media.id, mediaIds))
        .all()
        .flatMap((s) => {
          const tmdbId = Number(s.tmdbId);
          return s.tmdbId && Number.isInteger(tmdbId) && tmdbId > 0 ? [{ type: s.type, tmdbId }] : [];
        })
    : [];
  if (!seeds.length) return keep(skipped('no-history'));

  const perSeed = await mapLimit(seeds, CONCURRENCY, async (seed) => {
    try {
      // TMDb numbers movies and shows separately, so suggestions stay typed (see dedupe.ts).
      return (await suggestionsFor(source, seed.type, seed.tmdbId)).map((id) => `${seed.type}:${id}`);
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err), tmdbId: seed.tmdbId }, 'similar-title lookup failed');
      return null;
    }
  });
  // Some lookups failing still leaves good data to narrow on; all of them failing doesn't.
  if (perSeed.every((keys) => keys === null)) return keep(skipped('unavailable', seeds.length));

  const suggested = new Set(perSeed.flatMap((keys) => keys ?? []));
  const narrowed = pool.filter((row) => row.tmdbId && suggested.has(`${row.type}:${row.tmdbId}`));
  if (!narrowed.length) return keep(skipped('no-matches', seeds.length));
  return { pool: narrowed, info: { status: 'applied', seedCount: seeds.length, matchCount: narrowed.length } };
}
