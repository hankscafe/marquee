import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyError } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyHelmet from '@fastify/helmet';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { config } from './config.js';
import { logger } from './logger.js';
import { authPlugin } from './auth/plugin.js';
import { authRoutes } from './auth/routes.js';
import { adminRoutes } from './routes/admin.js';
import { adminUserRoutes } from './routes/adminUsers.js';
import { collectionRoutes } from './routes/collections.js';
import { discordRoutes } from './routes/discord.js';
import { franchiseRoutes } from './routes/franchises.js';
import { issueRoutes } from './routes/issues.js';
import { requestRoutes } from './routes/requests.js';
import { listRoutes } from './routes/lists.js';
import { mediaRoutes } from './routes/media.js';
import { nowPlayingRoutes } from './routes/nowplaying.js';
import { passkeyRoutes } from './routes/passkeys.js';
import { pollRoutes } from './routes/polls.js';
import { publicPollRoutes } from './routes/publicPolls.js';
import { scheduleRoutes } from './routes/schedules.js';
import { traktRoutes } from './routes/trakt.js';
import { versionRoutes } from './routes/version.js';
import { watchWithRoutes } from './routes/watchwith.js';
import { widgetRoutes } from './routes/widget.js';

export async function buildApp() {
  const app = Fastify({
    loggerInstance: logger,
    // Which reverse proxies' X-Forwarded-* to believe (secure cookies + rate-limit IPs); see config.ts.
    trustProxy: config.trustProxy,
    // Drop open connections on shutdown, including live-result streams that never end on their own.
    forceCloseConnections: true,
  });

  // Must come before any route is registered: Fastify fixes each route's error
  // handler at registration, so routes added earlier would keep the default one
  // and send raw internal error messages (e.g. SQLite errors) to clients.
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
    if (status >= 500) request.log.error(error);
    else request.log.info({ err: error.message, status }, 'request rejected');
    reply.code(status).send({ error: status === 500 ? 'Internal server error' : error.message });
  });

  await app.register(fastifyHelmet, {
    // Everything the app loads comes from Marquee itself (the Vite build has no
    // inline scripts or styles), except TMDb's posters on the Collections page.
    // Only Marquee may frame itself, as X-Frame-Options already said. Requests
    // aren't upgraded to https: Marquee is often reached over plain http at home.
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'blob:', 'https://image.tmdb.org'],
        fontSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        manifestSrc: ["'self'"],
        workerSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  });

  // Refuse changes requested by another site's page — a vote cast or a setting
  // changed from a link someone was sent. Browsers say where a request came
  // from in Sec-Fetch-Site, which a reverse proxy can't distort (unlike Origin
  // vs Host). Requests without it — the widget, scripts, older browsers — pass;
  // SameSite cookies still keep sessions off cross-site requests for those.
  app.addHook('onRequest', async (request, reply) => {
    if (request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS') return;
    const site = request.headers['sec-fetch-site'];
    if (site === 'cross-site' || site === 'same-site') {
      return reply.code(403).send({ error: 'Requests from other sites aren’t allowed' });
    }
  });
  await app.register(fastifyRateLimit, { global: false });
  await app.register(fastifyCookie, { secret: config.sessionSecret });
  await app.register(authPlugin);
  await app.register(authRoutes);
  await app.register(passkeyRoutes);
  await app.register(pollRoutes);
  await app.register(publicPollRoutes);
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
  await app.register(adminUserRoutes);
  await app.register(versionRoutes);
  await app.register(widgetRoutes);

  app.get('/api/health', async () => ({ ok: true, version: config.version }));

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
