import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../auth/plugin.js';
import { getSeerrConfig, requestMovie } from '../seerr/client.js';

export async function requestRoutes(app: FastifyInstance) {
  // Forward a movie request to the configured Overseerr/Jellyseerr/Ombi instance.
  app.post('/api/requests', { preHandler: requireUser }, async (request, reply) => {
    const cfg = getSeerrConfig();
    if (!cfg) return reply.code(503).send({ error: 'No request service is configured — ask your admin' });
    const parsed = z.object({ tmdbId: z.number().int().positive() }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid request' });
    try {
      await requestMovie(cfg, parsed.data.tmdbId);
      return { ok: true };
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : 'Request failed' });
    }
  });
}
