import type { FastifyInstance } from 'fastify';
import { and, asc, eq, like, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.js';
import { collectionItems, collections, media } from '../db/schema.js';
import { requireUser } from '../auth/plugin.js';
import { fetchJfArtwork } from '../jellyfin/client.js';
import { fetchArtwork } from '../plex/client.js';
import { pickRandomMedia } from '../randomizer/service.js';
import { getPlexConfig, getSetting } from '../settings.js';

export const randomFiltersSchema = z.object({
  type: z.enum(['movie', 'show']).optional(),
  genre: z.string().max(100).optional(),
  section: z.string().max(200).optional(),
  collectionId: z.number().int().optional(),
  listId: z.number().int().optional(),
  unwatchedOnly: z.boolean().optional(),
  yearFrom: z.number().int().optional(),
  yearTo: z.number().int().optional(),
  minRating: z.number().min(0).max(10).optional(),
});

// Deep link into the source server's web app for this title.
function buildWatchUrl(row: typeof media.$inferSelect): string | null {
  if (row.source === 'plex') {
    const machineId = getSetting('plex.machineId');
    return machineId
      ? `https://app.plex.tv/desktop#!/server/${machineId}/details?key=${encodeURIComponent(`/library/metadata/${row.ratingKey}`)}`
      : null;
  }
  const url = getSetting(`${row.source}.url`);
  if (!url) return null;
  const serverId = getSetting(`${row.source}.serverId`) ?? '';
  const path = row.source === 'jellyfin' ? 'details' : 'item';
  return `${url.replace(/\/+$/, '')}/web/index.html#!/${path}?id=${row.ratingKey}&serverId=${serverId}`;
}

// Tag lists are stored as JSON strings; parse before sending to clients.
export function serializeMedia(row: typeof media.$inferSelect) {
  const parse = (value: string | null) => (value ? (JSON.parse(value) as string[]) : null);
  return {
    ...row,
    genres: parse(row.genres),
    directors: parse(row.directors),
    actors: parse(row.actors),
    watchUrl: buildWatchUrl(row),
  };
}

export async function mediaRoutes(app: FastifyInstance) {
  app.get('/api/media', { preHandler: requireUser }, async (request) => {
    const { q, type, sort } = request.query as { q?: string; type?: string; sort?: string };
    const conditions: SQL[] = [];
    if (q) conditions.push(like(media.title, `%${q}%`));
    if (type === 'movie' || type === 'show') conditions.push(eq(media.type, type));
    const rows = db
      .select()
      .from(media)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(sort === 'random' ? sql`random()` : asc(media.title))
      .limit(60)
      .all();
    return rows.map(serializeMedia);
  });

  // Filter options for the randomizer: library sections, genres, and Plex collections.
  app.get('/api/media/filters', { preHandler: requireUser }, async () => {
    const sections = db
      .selectDistinct({ s: media.librarySection })
      .from(media)
      .all()
      .map((r) => r.s)
      .filter((s): s is string => !!s)
      .sort();
    const genres = [
      ...new Set(
        db
          .select({ g: media.genres })
          .from(media)
          .all()
          .flatMap((r) => (r.g ? (JSON.parse(r.g) as string[]) : [])),
      ),
    ].sort();
    const cols = db
      .select()
      .from(collections)
      .orderBy(asc(collections.title))
      .all()
      .map((c) => ({
        id: c.id,
        title: c.title,
        librarySection: c.librarySection,
        itemCount: db
          .select({ c: sql<number>`count(*)` })
          .from(collectionItems)
          .where(eq(collectionItems.collectionId, c.id))
          .get()!.c,
      }));
    return { sections, genres, collections: cols };
  });

  // Fetch one title's full metadata (synopsis, cast, crew, rating).
  app.get('/api/media/:id', { preHandler: requireUser }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const item = db.select().from(media).where(eq(media.id, id)).get();
    if (!item) return reply.code(404).send({ error: 'Title not found' });
    return serializeMedia(item);
  });

  app.post('/api/media/random', { preHandler: requireUser }, async (request, reply) => {
    const parsed = randomFiltersSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid request' });
    const pick = await pickRandomMedia(parsed.data, request.user!.id);
    if (!pick) {
      return reply.code(404).send({ error: 'No titles match those filters. Try widening them or sync your library.' });
    }
    return serializeMedia(pick);
  });

  // Poster proxy: streams artwork from the source server so tokens/keys stay server-side.
  app.get('/api/media/:id/poster', { preHandler: requireUser }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const item = db.select().from(media).where(eq(media.id, id)).get();
    if (!item?.thumb) return reply.code(404).send({ error: 'No poster available' });

    let res: Response;
    if (item.source === 'plex') {
      const cfg = getPlexConfig();
      if (!cfg) return reply.code(404).send({ error: 'Plex is not configured' });
      res = await fetchArtwork(cfg.url, cfg.token, item.thumb);
    } else {
      try {
        res = await fetchJfArtwork(item.source, item.thumb);
      } catch (err) {
        return reply.code(404).send({ error: err instanceof Error ? err.message : 'Source not configured' });
      }
    }
    if (!res.ok) return reply.code(502).send({ error: 'Failed to fetch poster from the media server' });
    reply.header('content-type', res.headers.get('content-type') ?? 'image/jpeg');
    reply.header('cache-control', 'private, max-age=86400');
    return reply.send(Buffer.from(await res.arrayBuffer()));
  });
}
