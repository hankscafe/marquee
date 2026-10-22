import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { and, asc, eq, isNotNull, isNull, like, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.js';
import { collectionItems, collections, media } from '../db/schema.js';
import { requireUser } from '../auth/plugin.js';
import { fetchJfArtwork, getJfConfig } from '../jellyfin/client.js';
import { fetchArtwork } from '../plex/client.js';
import { pickRandomMedia } from '../randomizer/service.js';
import { getPlexConfig, getSetting } from '../settings.js';
import { dedupeMedia } from '../sources/dedupe.js';
import { serverUrl } from '../urls.js';

const RESULTS_PER_PAGE = 60;

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
  return serverUrl(url, `web/index.html#!/${path}?id=${row.ratingKey}&serverId=${serverId}`).href;
}

// Tag lists are stored as JSON strings; parse before sending to clients.
export function serializeMedia(row: typeof media.$inferSelect) {
  const parse = (value: string | null) => (value ? (JSON.parse(value) as string[]) : null);
  const { removedAt, ...fields } = row;
  delete (fields as { copyIds?: number[] }).copyIds; // dedupeMedia bookkeeping, not for clients
  return {
    ...fields,
    genres: parse(row.genres),
    directors: parse(row.directors),
    actors: parse(row.actors),
    watchUrl: buildWatchUrl(row),
    removed: removedAt !== null, // no longer on its media server; kept for old polls and lists
  };
}

// Poster sizes the media servers are asked for. A few fixed widths keep
// browser caching effective: grids get the default, Poster Mode's wall display
// the large one, the login backdrop's small tiles the small one.
const POSTER_WIDTHS = [300, 600, 1200] as const;
const DEFAULT_POSTER_WIDTH = 600;

function posterWidth(requested: unknown): number {
  const n = Number(requested);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_POSTER_WIDTH;
  return POSTER_WIDTHS.find((w) => w >= n) ?? POSTER_WIDTHS[POSTER_WIDTHS.length - 1];
}

const BACKDROP_POOL_SIZE = 12;
const BACKDROP_POOL_TTL_MS = 6 * 60 * 60 * 1000;
let backdrop: { items: { source: (typeof media.$inferSelect)['source']; thumb: string | null }[]; expiresAt: number } | null = null;

function backdropPool() {
  if (backdrop && backdrop.expiresAt > Date.now()) return backdrop.items;
  const items = db
    .select({ source: media.source, thumb: media.thumb })
    .from(media)
    .where(and(isNotNull(media.thumb), isNull(media.removedAt)))
    .orderBy(sql`random()`)
    .limit(BACKDROP_POOL_SIZE)
    .all();
  // Never keep an empty sample: the first sync shouldn't have to wait it out.
  if (items.length) backdrop = { items, expiresAt: Date.now() + BACKDROP_POOL_TTL_MS };
  return items;
}

// Poster proxy: streams artwork from the source server so tokens/keys stay server-side.
export async function streamPoster(
  item: { source: 'plex' | 'jellyfin' | 'emby'; thumb: string | null },
  reply: FastifyReply,
  cacheControl: string,
  width = DEFAULT_POSTER_WIDTH,
) {
  if (!item.thumb) return reply.code(404).send({ error: 'No poster available' });
  let request: () => Promise<Response>;
  if (item.source === 'plex') {
    const cfg = getPlexConfig();
    if (!cfg) return reply.code(404).send({ error: 'Plex is not configured' });
    request = () => fetchArtwork(cfg.url, cfg.token, item.thumb!, width);
  } else {
    const kind = item.source;
    if (!getJfConfig(kind)) return reply.code(404).send({ error: `${kind} is not configured` });
    request = () => fetchJfArtwork(kind, item.thumb!, width);
  }
  let res: Response;
  try {
    res = await request();
  } catch {
    // Unreachable or too slow: the client falls back to a placeholder, so this isn't a server error.
    return reply.code(502).send({ error: 'Failed to fetch poster from the media server' });
  }
  if (!res.ok) {
    void res.body?.cancel();
    return reply.code(502).send({ error: 'Failed to fetch poster from the media server' });
  }
  reply.header('content-type', res.headers.get('content-type') ?? 'image/jpeg');
  reply.header('cache-control', cacheControl);
  // Passed through as it arrives rather than held in memory first.
  return reply.send(res.body ? Readable.fromWeb(res.body) : '');
}

export async function mediaRoutes(app: FastifyInstance) {
  app.get('/api/media', { preHandler: requireUser }, async (request) => {
    const { q, type, sort, section, genre } = request.query as {
      q?: string;
      type?: string;
      sort?: string;
      section?: string;
      genre?: string;
    };
    const conditions: SQL[] = [isNull(media.removedAt)];
    if (q) conditions.push(like(media.title, `%${q}%`));
    if (type === 'movie' || type === 'show') conditions.push(eq(media.type, type));
    if (section) conditions.push(eq(media.librarySection, section));
    if (genre) conditions.push(like(media.genres, `%"${genre}"%`));
    // Fetch extra: with several servers, copies of one title collapse into one,
    // and limiting first would leave far fewer than a page of results.
    const rows = db
      .select()
      .from(media)
      .where(and(...conditions))
      .orderBy(sort === 'random' ? sql`random()` : asc(media.title))
      .limit(RESULTS_PER_PAGE * 3)
      .all();
    return dedupeMedia(rows).slice(0, RESULTS_PER_PAGE).map(serializeMedia);
  });

  // Filter options for the randomizer: library sections, genres, and collections.
  app.get('/api/media/filters', { preHandler: requireUser }, async () => {
    const onServer = isNull(media.removedAt);
    const sections = db
      .selectDistinct({ s: media.librarySection })
      .from(media)
      .where(onServer)
      .all()
      .map((r) => r.s)
      .filter((s): s is string => !!s)
      .sort();
    const genres = [
      ...new Set(
        db
          .select({ g: media.genres })
          .from(media)
          .where(onServer)
          .all()
          .flatMap((r) => (r.g ? (JSON.parse(r.g) as string[]) : [])),
      ),
    ].sort();
    const itemCounts = new Map(
      db
        .select({ id: collectionItems.collectionId, n: sql<number>`count(*)` })
        .from(collectionItems)
        .innerJoin(media, eq(collectionItems.mediaId, media.id))
        .where(onServer)
        .groupBy(collectionItems.collectionId)
        .all()
        .map((r) => [r.id, r.n]),
    );
    const cols = db
      .select()
      .from(collections)
      .orderBy(asc(collections.title))
      .all()
      .map((c) => ({ id: c.id, title: c.title, librarySection: c.librarySection, itemCount: itemCounts.get(c.id) ?? 0 }));
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
    const pick = await pickRandomMedia(parsed.data, request.user!);
    if (!pick) {
      return reply.code(404).send({ error: 'No titles match those filters. Try widening them or sync your library.' });
    }
    return serializeMedia(pick);
  });

  app.get('/api/media/:id/poster', { preHandler: requireUser }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const item = db.select({ source: media.source, thumb: media.thumb }).from(media).where(eq(media.id, id)).get();
    if (!item) return reply.code(404).send({ error: 'No poster available' });
    return streamPoster(item, reply, 'private, max-age=86400', posterWidth((request.query as { w?: string }).w));
  });

  // Unauthenticated: a random poster for the login-page backdrop. Streams
  // artwork only — no titles or metadata leave the server. Rate-limited because
  // it is pre-auth and drives a token-bearing request to the internal media server.
  // Drawn from a small sample that changes every few hours, so nobody can page
  // through the whole library's artwork without signing in.
  app.get('/api/backdrop', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (_request, reply) => {
    const pool = backdropPool();
    if (!pool.length) return reply.code(404).send({ error: 'No artwork yet' });
    // The login page's backdrop tiles are small and faded.
    return streamPoster(pool[crypto.randomInt(pool.length)]!, reply, 'no-store', POSTER_WIDTHS[0]);
  });
}
