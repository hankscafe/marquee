import type { FastifyInstance } from 'fastify';
import { and, asc, eq, isNotNull, isNull } from 'drizzle-orm';
import { db } from '../db/index.js';
import { media, tmdbCollectionParts, tmdbCollections } from '../db/schema.js';
import { requireUser } from '../auth/plugin.js';
import { canRequest } from '../seerr/client.js';
import { requesterFor } from './requests.js';

// TMDb ids of the movies in the library, for owned/missing computation. Movies
// only: TV shows have TMDb ids too, from a separate numbering that overlaps.
function libraryTmdbIds(): Map<string, number> {
  const rows = db
    .select({ id: media.id, tmdbId: media.tmdbId })
    .from(media)
    .where(and(eq(media.type, 'movie'), isNotNull(media.tmdbId), isNull(media.removedAt)))
    .all();
  return new Map(rows.map((r) => [r.tmdbId!, r.id]));
}

export async function franchiseRoutes(app: FastifyInstance) {
  app.get('/api/franchises', { preHandler: requireUser }, async (request) => {
    const lib = libraryTmdbIds();
    // Every franchise's parts in one query, grouped here.
    const partsOf = new Map<number, string[]>();
    for (const p of db
      .select({ collectionId: tmdbCollectionParts.collectionId, tmdbMovieId: tmdbCollectionParts.tmdbMovieId })
      .from(tmdbCollectionParts)
      .all()) {
      if (!partsOf.has(p.collectionId)) partsOf.set(p.collectionId, []);
      partsOf.get(p.collectionId)!.push(p.tmdbMovieId);
    }
    const cols = db.select().from(tmdbCollections).orderBy(asc(tmdbCollections.name)).all();
    const franchises = cols
      .map((c) => {
        const parts = partsOf.get(c.id) ?? [];
        const owned = parts.filter((id) => lib.has(id)).length;
        return { id: c.id, name: c.name, total: parts.length, owned, missing: parts.length - owned };
      })
      .filter((f) => f.total > 0 && f.owned > 0);
    return { requestsEnabled: await canRequest(requesterFor(request.user!)), franchises };
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
    return { id: col.id, name: col.name, requestsEnabled: await canRequest(requesterFor(request.user!)), parts };
  });
}
