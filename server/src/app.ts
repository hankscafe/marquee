import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyError } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { config } from './config.js';
import { authPlugin } from './auth/plugin.js';
import { authRoutes } from './auth/routes.js';
import { adminRoutes } from './routes/admin.js';
import { collectionRoutes } from './routes/collections.js';
import { discordRoutes } from './routes/discord.js';
import { franchiseRoutes } from './routes/franchises.js';
import { issueRoutes } from './routes/issues.js';
import { requestRoutes } from './routes/requests.js';
import { listRoutes } from './routes/lists.js';
import { mediaRoutes } from './routes/media.js';
import { nowPlayingRoutes } from './routes/nowplaying.js';
import { pollRoutes } from './routes/polls.js';
import { scheduleRoutes } from './routes/schedules.js';
import { traktRoutes } from './routes/trakt.js';
import { watchWithRoutes } from './routes/watchwith.js';

export async function buildApp() {
  const app = Fastify({ logger: { level: config.isProd ? 'info' : 'debug' } });

  await app.register(fastifyCookie, { secret: config.sessionSecret });
  await app.register(authPlugin);
  await app.register(authRoutes);
  await app.register(pollRoutes);
  await app.register(mediaRoutes);
  await app.register(listRoutes);
  await app.register(collectionRoutes);
  await app.register(franchiseRoutes);
  await app.register(requestRoutes);
  await app.register(traktRoutes);
  await app.register(watchWithRoutes);
  await app.register(nowPlayingRoutes);
  await app.register(scheduleRoutes);
  await app.register(discordRoutes);
  await app.register(issueRoutes);
  await app.register(adminRoutes);

  app.get('/api/health', async () => ({ ok: true }));

  app.setErrorHandler((error: FastifyError, _request, reply) => {
    app.log.error(error);
    const status = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
    reply.code(status).send({ error: status === 500 ? 'Internal server error' : error.message });
  });

  // In production the server also serves the built client (SPA fallback for client routes).
  const clientDist = path.join(import.meta.dirname, '../../client/dist');
  if (fs.existsSync(clientDist)) {
    await app.register(fastifyStatic, { root: clientDist });
    app.setNotFoundHandler((request, reply) => {
      if (request.raw.url?.startsWith('/api/')) {
        return reply.code(404).send({ error: 'Not found' });
      }
      return reply.sendFile('index.html');
    });
  }

  return app;
}
