import { and, eq, notInArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { collectionItems, collections, media } from '../db/schema.js';
import type { SourceSyncData } from './types.js';

// Persist one source's fetched data in a single transaction (one disk flush per
// sync). Upserts are keyed on (source, ratingKey); collections that vanished
// from the source are pruned, but only within that source.
export function writeSourceData(data: SourceSyncData): { items: number; collections: number } {
  let items = 0;
  db.transaction((tx) => {
    const toJson = (list: string[] | null) => (list?.length ? JSON.stringify(list) : null);

    for (const item of data.items) {
      const fields = {
        title: item.title,
        year: item.year,
        type: item.type,
        thumb: item.thumb,
        summary: item.summary,
        durationMs: item.durationMs,
        librarySection: item.librarySection,
        genres: toJson(item.genres),
        imdbId: item.imdbId,
        tmdbId: item.tmdbId,
        rating: item.rating,
        contentRating: item.contentRating,
        directors: toJson(item.directors),
        actors: toJson(item.actors),
        watched: item.watched,
        syncedAt: new Date(),
      };
      tx.insert(media)
        .values({ source: data.source, ratingKey: item.ratingKey, ...fields })
        .onConflictDoUpdate({ target: [media.source, media.ratingKey], set: fields })
        .run();
      items++;
    }

    for (const col of data.collections) {
      const fields = { title: col.title, librarySection: col.librarySection, syncedAt: new Date() };
      const row = tx
        .insert(collections)
        .values({ source: data.source, ratingKey: col.ratingKey, ...fields })
        .onConflictDoUpdate({ target: [collections.source, collections.ratingKey], set: fields })
        .returning()
        .get();
      tx.delete(collectionItems).where(eq(collectionItems.collectionId, row.id)).run();
      for (const childKey of col.childRatingKeys) {
        const m = tx
          .select({ id: media.id })
          .from(media)
          .where(and(eq(media.source, data.source), eq(media.ratingKey, childKey)))
          .get();
        if (m) {
          tx.insert(collectionItems)
            .values({ collectionId: row.id, mediaId: m.id })
            .onConflictDoNothing()
            .run();
        }
      }
    }

    const seen = data.collections.map((c) => c.ratingKey);
    tx.delete(collections)
      .where(
        seen.length
          ? and(eq(collections.source, data.source), notInArray(collections.ratingKey, seen))
          : eq(collections.source, data.source),
      )
      .run();
  });

  return { items, collections: data.collections.length };
}
