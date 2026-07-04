import type { FastifyInstance } from 'fastify';
import { asc, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { collectionItems, collections, media } from '../db/schema.js';
import { requireUser } from '../auth/plugin.js';
import { getWatchedSet } from '../trakt/service.js';
import { serializeMedia } from './media.js';

// "Watched" is personal when the user has connected Trakt; otherwise it falls
// back to the watch flag of the Plex account used for syncing.
function isWatched(item: { id: number; watched: boolean }, watchedSet: Set<number> | null): boolean {
  return watchedSet ? watchedSet.has(item.id) : item.watched;
}

export async function collectionRoutes(app: FastifyInstance) {
  app.get('/api/collections', { preHandler: requireUser }, async (request) => {
    const watchedSet = getWatchedSet(request.user!.id);
    const cols = db.select().from(collections).orderBy(asc(collections.title)).all();
    return cols.map((c) => {
      const items = db
        .select({ id: media.id, watched: media.watched })
        .from(collectionItems)
        .innerJoin(media, eq(collectionItems.mediaId, media.id))
        .where(eq(collectionItems.collectionId, c.id))
        .all();
      return {
        id: c.id,
        title: c.title,
        librarySection: c.librarySection,
        itemCount: items.length,
        watchedCount: items.filter((i) => isWatched(i, watchedSet)).length,
      };
    });
  });

  app.get('/api/collections/:id', { preHandler: requireUser }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const col = db.select().from(collections).where(eq(collections.id, id)).get();
    if (!col) return reply.code(404).send({ error: 'Collection not found' });
    const watchedSet = getWatchedSet(request.user!.id);
    const items = db
      .select({ media })
      .from(collectionItems)
      .innerJoin(media, eq(collectionItems.mediaId, media.id))
      .where(eq(collectionItems.collectionId, col.id))
      .all()
      .map((r) => ({ ...serializeMedia(r.media), watchedByMe: isWatched(r.media, watchedSet) }));
    // Watched first is confusing for "what should we watch next" — unwatched first.
    items.sort((a, b) => Number(a.watchedByMe) - Number(b.watchedByMe) || (a.year ?? 0) - (b.year ?? 0));
    return {
      id: col.id,
      title: col.title,
      librarySection: col.librarySection,
      itemCount: items.length,
      watchedCount: items.filter((i) => i.watchedByMe).length,
      items,
    };
  });
}
