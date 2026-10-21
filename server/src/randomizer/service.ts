import crypto from 'node:crypto';
import { and, eq, gte, isNull, like, lte, type SQL } from 'drizzle-orm';
import { db } from '../db/index.js';
import { collectionItems, listItems, lists, media } from '../db/schema.js';
import { dedupeColumns, dedupeMedia, fullRow, type DedupeFields } from '../sources/dedupe.js';
import { watchedSetForUser } from '../watchwith/service.js';

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
}

// One random title matching the filters, or null. `viewer` personalizes the
// unwatched filter (Trakt → own Plex account → sync account) and gates the
// `listId` filter so a caller can only draw from lists they may view.
export async function pickRandomMedia(
  filters: RandomFilters,
  viewer: { id: number; isAdmin: boolean },
): Promise<typeof media.$inferSelect | null> {
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
    if (!list || !(list.isShared || list.ownerId === viewer.id || viewer.isAdmin)) return null;
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

  return pool.length ? fullRow(pool[crypto.randomInt(pool.length)]!) : null;
}
