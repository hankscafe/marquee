import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { eq, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.js';
import { media, users } from '../db/schema.js';
import { requireUser } from '../auth/plugin.js';
import { decryptSecret } from '../crypto.js';
import { getSeerrConfig } from '../seerr/client.js';
import { dedupeMedia } from '../sources/dedupe.js';
import { fetchWatchlist, watchedSetForUser, watchlistKey } from '../watchwith/service.js';
import { serializeMedia } from './media.js';

export async function watchWithRoutes(app: FastifyInstance) {
  // Everyone else on the instance, with what history sources they bring.
  app.get('/api/watchwith/partners', { preHandler: requireUser }, async (request) => {
    // Reduce token presence to booleans in SQL so other users' encrypted
    // tokens never enter application memory here.
    return db
      .select({
        id: users.id,
        username: users.username,
        hasPlex: sql<number>`(${users.plexToken} is not null)`,
        hasTrakt: sql<number>`(${users.traktToken} is not null)`,
      })
      .from(users)
      .where(ne(users.id, request.user!.id))
      .all()
      .map((u) => ({ id: u.id, username: u.username, hasPlex: !!u.hasPlex, hasTrakt: !!u.hasTrakt }));
  });

  // Library mode: a random title neither person has seen.
  app.post('/api/watchwith/library', { preHandler: requireUser }, async (request, reply) => {
    const parsed = z
      .object({ partnerId: z.number().int(), type: z.enum(['movie', 'show']).optional() })
      .safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid request' });
    if (parsed.data.partnerId === request.user!.id) {
      return reply.code(400).send({ error: 'Pick someone other than yourself — that’s just the randomizer' });
    }
    const partner = db.select({ id: users.id }).from(users).where(eq(users.id, parsed.data.partnerId)).get();
    if (!partner) return reply.code(404).send({ error: 'Partner not found' });

    const [mine, theirs] = await Promise.all([
      watchedSetForUser(request.user!.id),
      watchedSetForUser(partner.id),
    ]);

    const rows = dedupeMedia(
      db
        .select()
        .from(media)
        .where(parsed.data.type ? eq(media.type, parsed.data.type) : undefined)
        .all(),
    );
    const pool = rows.filter((r) => !mine.set.has(r.id) && !theirs.set.has(r.id));
    if (!pool.length) {
      return reply.code(404).send({ error: 'No titles left that neither of you has seen — impressive. Try widening the filter.' });
    }

    return {
      pick: serializeMedia(pool[crypto.randomInt(pool.length)]!),
      poolSize: pool.length,
      myMethod: mine.method,
      partnerMethod: theirs.method,
    };
  });

  // Watchlist mode: intersect both plex.tv watchlists.
  app.post('/api/watchwith/watchlist', { preHandler: requireUser }, async (request, reply) => {
    const parsed = z.object({ partnerId: z.number().int() }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid request' });

    const me = db.select().from(users).where(eq(users.id, request.user!.id)).get();
    const partner = db.select().from(users).where(eq(users.id, parsed.data.partnerId)).get();
    if (!partner) return reply.code(404).send({ error: 'Partner not found' });
    if (!me?.plexToken) {
      return reply.code(400).send({ error: 'Watchlist mode needs your Plex account — sign in with Plex first' });
    }
    if (!partner.plexToken) {
      return reply.code(400).send({ error: `${partner.username} hasn’t signed in with Plex, so their watchlist isn’t available. Use library mode instead.` });
    }

    let overlap;
    try {
      const [myList, theirList] = await Promise.all([
        fetchWatchlist(decryptSecret(me.plexToken)),
        fetchWatchlist(decryptSecret(partner.plexToken)),
      ]);
      const theirKeys = new Set(theirList.map(watchlistKey));
      overlap = myList.filter((item) => theirKeys.has(watchlistKey(item)));
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : 'Could not fetch watchlists' });
    }
    if (!overlap.length) {
      return reply.code(404).send({ error: 'Your watchlists don’t overlap (yet) — add some shared picks on plex.tv' });
    }

    const pick = overlap[crypto.randomInt(overlap.length)]!;

    // If the pick is already in the library, return the full local record.
    let mediaRow = null;
    for (const guid of pick.guids) {
      if (guid.startsWith('imdb://')) {
        mediaRow = db.select().from(media).where(eq(media.imdbId, guid.slice(7))).get() ?? null;
      } else if (guid.startsWith('tmdb://')) {
        mediaRow = db.select().from(media).where(eq(media.tmdbId, guid.slice(7))).get() ?? null;
      }
      if (mediaRow) break;
    }
    const tmdbGuid = pick.guids.find((g) => g.startsWith('tmdb://'));

    return {
      poolSize: overlap.length,
      title: pick.title,
      year: pick.year,
      type: pick.type,
      media: mediaRow ? serializeMedia(mediaRow) : null,
      tmdbId: tmdbGuid ? Number(tmdbGuid.slice(7)) : null,
      requestsEnabled: !!getSeerrConfig(),
    };
  });
}
