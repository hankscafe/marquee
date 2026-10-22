import crypto from 'node:crypto';
import { and, eq, gte, isNull, like, lte, type SQL } from 'drizzle-orm';
import type { SimilarToRecentInfo } from '@marquee/shared';
import { db } from '../db/index.js';
import { collectionItems, listItems, lists, media } from '../db/schema.js';
import { dedupeColumns, dedupeMedia, fullRow, type DedupeFields } from '../sources/dedupe.js';
import { watchedSetForUser } from '../watchwith/service.js';
import { narrowToSimilar, SEED_COUNT_DEFAULT, SEED_COUNT_MAX } from './similar.js';

export interface RandomFilters {
  type?: 'movie' | 'show';
  genre?: string;
  section?: string;
  collectionId?: number;
  listId?: number;
  unwatchedOnly?: boolean;
  yearFrom?: number;
  yearTo?: number;
  minRating?: number;
  similarToRecent?: boolean;
  recentSeedCount?: number;
}

export interface RandomResult {
  pick: typeof media.$inferSelect | null;
  similarToRecent?: SimilarToRecentInfo; // only when that filter was asked for
}

// One random title matching the filters, or none. `viewer` personalizes the
// unwatched and similar-to-recent filters (Trakt → own Plex account → sync
// account) and gates the `listId` filter so a caller can only draw from lists
// they may view.
export async function pickRandomMedia(
  filters: RandomFilters,
  viewer: { id: number; isAdmin: boolean },
): Promise<RandomResult> {
  // Titles gone from the media server are never drawn, whatever the pool.
  const conditions: SQL[] = [isNull(media.removedAt)];
  if (filters.type) conditions.push(eq(media.type, filters.type));
  if (filters.genre) conditions.push(like(media.genres, `%"${filters.genre}"%`));
  if (filters.section) conditions.push(eq(media.librarySection, filters.section));
  if (filters.yearFrom) conditions.push(gte(media.year, filters.yearFrom));
  if (filters.yearTo) conditions.push(lte(media.year, filters.yearTo));
  if (filters.minRating) conditions.push(gte(media.rating, filters.minRating));
  const where = and(...conditions);

  // Only what deduping needs: the pool can be the whole library.
  let rows: DedupeFields[];
  if (filters.listId) {
    // Same visibility rule as GET /api/lists/:id — owner, shared, or admin.
    // Anything else is treated as "no match" so it can't be enumerated.
    const list = db.select().from(lists).where(eq(lists.id, filters.listId)).get();
    if (!list || !(list.isShared || list.ownerId === viewer.id || viewer.isAdmin)) return { pick: null };
    rows = db
      .select(dedupeColumns)
      .from(listItems)
      .innerJoin(media, eq(listItems.mediaId, media.id))
      .where(and(eq(listItems.listId, filters.listId), ...conditions))
      .all();
  } else if (filters.collectionId) {
    rows = db
      .select(dedupeColumns)
      .from(collectionItems)
      .innerJoin(media, eq(collectionItems.mediaId, media.id))
      .where(and(eq(collectionItems.collectionId, filters.collectionId), ...conditions))
      .all();
  } else {
    rows = db.select(dedupeColumns).from(media).where(where).all();
  }

  // Cross-source duplicates would double-weight the draw — collapse them first.
  let pool = dedupeMedia(rows);

  if (filters.unwatchedOnly) {
    // A title counts as watched if any of its copies is (e.g. seen on Jellyfin, drawn from Plex).
    const { set } = await watchedSetForUser(viewer.id);
    pool = pool.filter((r) => !r.copyIds.some((id) => set.has(id)));
  }

  let similarToRecent: SimilarToRecentInfo | undefined;
  if (filters.similarToRecent) {
    // Last, so its match count counts what the other filters already allowed.
    const seedCount = Math.min(Math.max(filters.recentSeedCount ?? SEED_COUNT_DEFAULT, 1), SEED_COUNT_MAX);
    const narrowed = await narrowToSimilar(pool, viewer.id, seedCount);
    pool = narrowed.pool;
    similarToRecent = narrowed.info;
  }

  return { pick: pool.length ? fullRow(pool[crypto.randomInt(pool.length)]!) : null, similarToRecent };
}
