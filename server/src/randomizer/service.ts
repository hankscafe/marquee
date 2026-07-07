import crypto from 'node:crypto';
import { and, eq, gte, like, lte, type SQL } from 'drizzle-orm';
import { db } from '../db/index.js';
import { collectionItems, listItems, lists, media } from '../db/schema.js';
import { dedupeMedia } from '../sources/dedupe.js';
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
  const conditions: SQL[] = [];
  if (filters.type) conditions.push(eq(media.type, filters.type));
  if (filters.genre) conditions.push(like(media.genres, `%"${filters.genre}"%`));
  if (filters.section) conditions.push(eq(media.librarySection, filters.section));
  if (filters.yearFrom) conditions.push(gte(media.year, filters.yearFrom));
  if (filters.yearTo) conditions.push(lte(media.year, filters.yearTo));
  if (filters.minRating) conditions.push(gte(media.rating, filters.minRating));
  const where = conditions.length ? and(...conditions) : undefined;

  let rows: (typeof media.$inferSelect)[];
  if (filters.listId) {
    // Same visibility rule as GET /api/lists/:id — owner, shared, or admin.
    // Anything else is treated as "no match" so it can't be enumerated.
    const list = db.select().from(lists).where(eq(lists.id, filters.listId)).get();
    if (!list || !(list.isShared || list.ownerId === viewer.id || viewer.isAdmin)) return null;
    rows = db
      .select({ media })
      .from(listItems)
      .innerJoin(media, eq(listItems.mediaId, media.id))
      .where(conditions.length ? and(eq(listItems.listId, filters.listId), ...conditions) : eq(listItems.listId, filters.listId))
      .all()
      .map((r) => r.media);
  } else if (filters.collectionId) {
    rows = db
      .select({ media })
      .from(collectionItems)
      .innerJoin(media, eq(collectionItems.mediaId, media.id))
      .where(
        conditions.length
          ? and(eq(collectionItems.collectionId, filters.collectionId), ...conditions)
          : eq(collectionItems.collectionId, filters.collectionId),
      )
      .all()
      .map((r) => r.media);
  } else {
    rows = db.select().from(media).where(where).all();
  }

  // Cross-source duplicates would double-weight the draw — collapse them first.
  rows = dedupeMedia(rows);

  if (filters.unwatchedOnly) {
    const { set } = await watchedSetForUser(viewer.id);
    rows = rows.filter((r) => !set.has(r.id));
  }

  return rows.length ? rows[crypto.randomInt(rows.length)]! : null;
}
