import type { FastifyInstance } from 'fastify';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { db } from '../db/index.js';
import { collectionItems, collections, media } from '../db/schema.js';
import { requireUser } from '../auth/plugin.js';
import { watchedSetForUser } from '../watchwith/service.js';
import { serializeMedia } from './media.js';

// "Watched" here means what the randomizer's unwatched filter means: the
// person's Trakt history, else their own Plex account's, else the watch flags
// of the account used for syncing.

export async function collectionRoutes(app: FastifyInstance) {
  app.get('/api/collections', { preHandler: requireUser }, async (request) => {
    const { set: watched } = await watchedSetForUser(request.user!.id);
    // Every collection's titles in one query (still on the server only), grouped here.
    const byCollection = new Map<number, { id: number }[]>();
    for (const row of db
      .select({ collectionId: collectionItems.collectionId, id: media.id })
      .from(collectionItems)
      .innerJoin(media, eq(collectionItems.mediaId, media.id))
      .where(isNull(media.removedAt))
      .all()) {
      if (!byCollection.has(row.collectionId)) byCollection.set(row.collectionId, []);
      byCollection.get(row.collectionId)!.push(row);
    }
    const cols = db.select().from(collections).orderBy(asc(collections.title)).all();
    return cols.map((c) => {
      const items = byCollection.get(c.id) ?? [];
      return {
        id: c.id,
        title: c.title,
        librarySection: c.librarySection,
        itemCount: items.length,
        watchedCount: items.filter((i) => watched.has(i.id)).length,
      };
    });
  });

  app.get('/api/collections/:id', { preHandler: requireUser }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const col = db.select().from(collections).where(eq(collections.id, id)).get();
    if (!col) return reply.code(404).send({ error: 'Collection not found' });
    const { set: watched } = await watchedSetForUser(request.user!.id);
    const items = db
      .select({ media })
      .from(collectionItems)
      .innerJoin(media, eq(collectionItems.mediaId, media.id))
      .where(and(eq(collectionItems.collectionId, col.id), isNull(media.removedAt)))
      .all()
      .map((r) => ({ ...serializeMedia(r.media), watchedByMe: watched.has(r.media.id) }));
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
