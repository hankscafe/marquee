import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/index.js';
import { issueReports } from '../db/schema.js';
import { requireUser } from '../auth/plugin.js';

export async function issueRoutes(app: FastifyInstance) {
  app.post('/api/issues', { preHandler: requireUser }, async (request, reply) => {
    const parsed = z
      .object({
        subject: z.string().min(1, 'Subject is required').max(200),
        body: z.string().min(1, 'Please describe the issue').max(5000),
      })
      .safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid request' });
    db.insert(issueReports)
      .values({ userId: request.user!.id, subject: parsed.data.subject, body: parsed.data.body })
      .run();
    return reply.code(201).send({ ok: true });
  });
}
