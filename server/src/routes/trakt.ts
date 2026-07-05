import type { FastifyInstance } from 'fastify';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { encryptSecret } from '../crypto.js';
import { db } from '../db/index.js';
import { users, userWatched } from '../db/schema.js';
import { requireUser } from '../auth/plugin.js';
import { createDeviceCode, getTraktApp, pollDeviceToken } from '../trakt/client.js';
import { refreshUserWatched } from '../trakt/service.js';

function watchedCount(userId: number): number {
  return db
    .select({ c: sql<number>`count(*)` })
    .from(userWatched)
    .where(eq(userWatched.userId, userId))
    .get()!.c;
}

export async function traktRoutes(app: FastifyInstance) {
  app.get('/api/trakt/status', { preHandler: requireUser }, async (request) => {
    const user = db.select({ traktToken: users.traktToken }).from(users).where(eq(users.id, request.user!.id)).get();
    return {
      configured: !!getTraktApp(),
      connected: !!user?.traktToken,
      watchedCount: watchedCount(request.user!.id),
    };
  });

  // Device flow step 1: get a short code the user enters at trakt.tv/activate.
  app.post('/api/trakt/connect', { preHandler: requireUser }, async (_request, reply) => {
    const traktApp = getTraktApp();
    if (!traktApp) return reply.code(503).send({ error: 'Trakt is not configured — ask your admin to add API credentials' });
    try {
      const code = await createDeviceCode(traktApp.clientId);
      return {
        deviceCode: code.device_code,
        userCode: code.user_code,
        verificationUrl: code.verification_url,
        interval: code.interval,
      };
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : 'Could not reach Trakt' });
    }
  });

  // Step 2: poll until the user has entered the code, then store tokens and pull watch history.
  app.post('/api/trakt/poll', { preHandler: requireUser }, async (request, reply) => {
    const traktApp = getTraktApp();
    if (!traktApp) return reply.code(503).send({ error: 'Trakt is not configured' });
    const parsed = z.object({ deviceCode: z.string().min(1) }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid request' });

    let result;
    try {
      result = await pollDeviceToken(traktApp.clientId, traktApp.clientSecret, parsed.data.deviceCode);
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : 'Could not reach Trakt' });
    }
    if (result === 'pending') return { pending: true };

    db.update(users)
      .set({ traktToken: encryptSecret(result.accessToken), traktRefresh: encryptSecret(result.refreshToken) })
      .where(eq(users.id, request.user!.id))
      .run();

    // Pull history right away; a failure here shouldn't undo the connection.
    let count = 0;
    try {
      count = await refreshUserWatched(request.user!.id);
    } catch (err) {
      request.log.warn(err, 'initial Trakt watched sync failed');
    }
    return { connected: true, watchedCount: count };
  });

  app.post('/api/trakt/refresh', { preHandler: requireUser }, async (request, reply) => {
    try {
      const count = await refreshUserWatched(request.user!.id);
      return { watchedCount: count };
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : 'Trakt refresh failed' });
    }
  });

  app.post('/api/trakt/disconnect', { preHandler: requireUser }, async (request, reply) => {
    db.update(users).set({ traktToken: null, traktRefresh: null }).where(eq(users.id, request.user!.id)).run();
    db.delete(userWatched).where(eq(userWatched.userId, request.user!.id)).run();
    return reply.code(204).send();
  });
}
