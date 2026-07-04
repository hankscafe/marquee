import type { FastifyInstance } from 'fastify';
import { asc, eq, isNotNull } from 'drizzle-orm';
import { db } from '../db/index.js';
import { media, tmdbCollectionParts, tmdbCollections } from '../db/schema.js';
import { requireUser } from '../auth/plugin.js';
import { getSeerrConfig } from '../seerr/client.js';

// TMDb ids of everything in the library, for owned/missing computation.
function libraryTmdbIds(): Map<string, number> {
  const rows = db
    .select({ id: media.id, tmdbId: media.tmdbId })
    .from(media)
    .where(isNotNull(media.tmdbId))
    .all();
  return new Map(rows.map((r) => [r.tmdbId!, r.id]));
}

export async function franchiseRoutes(app: FastifyInstance) {
  app.get('/api/franchises', { preHandler: requireUser }, async () => {
    const lib = libraryTmdbIds();
    const cols = db.select().from(tmdbCollections).orderBy(asc(tmdbCollections.name)).all();
    const franchises = cols
      .map((c) => {
        const parts = db
          .select({ tmdbMovieId: tmdbCollectionParts.tmdbMovieId })
          .from(tmdbCollectionParts)
          .where(eq(tmdbCollectionParts.collectionId, c.id))
          .all();
        const owned = parts.filter((p) => lib.has(p.tmdbMovieId)).length;
        return { id: c.id, name: c.name, total: parts.length, owned, missing: parts.length - owned };
      })
      .filter((f) => f.total > 0 && f.owned > 0);
    return { requestsEnabled: !!getSeerrConfig(), franchises };
  });

  app.get('/api/franchises/:id', { preHandler: requireUser }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const col = db.select().from(tmdbCollections).where(eq(tmdbCollections.id, id)).get();
    if (!col) return reply.code(404).send({ error: 'Franchise not found' });
    const lib = libraryTmdbIds();
    const parts = db
      .select()
      .from(tmdbCollectionParts)
      .where(eq(tmdbCollectionParts.collectionId, col.id))
      .orderBy(asc(tmdbCollectionParts.year))
      .all()
      .map((p) => ({
        tmdbMovieId: p.tmdbMovieId,
        title: p.title,
        year: p.year,
        posterPath: p.posterPath,
        inLibrary: lib.has(p.tmdbMovieId),
        mediaId: lib.get(p.tmdbMovieId) ?? null,
      }));
    return { id: col.id, name: col.name, requestsEnabled: !!getSeerrConfig(), parts };
  });
}
