import type { FastifyInstance } from 'fastify';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.js';
import { media, scheduledPicks } from '../db/schema.js';
import { requireUser } from '../auth/plugin.js';
import { parseFilters, runSchedule } from '../schedules/service.js';
import { randomFiltersSchema, serializeMedia } from './media.js';

function serializeSchedule(row: typeof scheduledPicks.$inferSelect) {
  const lastPick = row.lastPickMediaId
    ? (db
        .select({ id: media.id, title: media.title, year: media.year })
        .from(media)
        .where(eq(media.id, row.lastPickMediaId))
        .get() ?? null)
    : null;
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    dayOfWeek: row.dayOfWeek,
    timeOfDay: row.timeOfDay,
    runAt: row.runAt,
    filters: parseFilters(row),
    postToDiscord: row.postToDiscord,
    enabled: row.enabled,
    lastRunAt: row.lastRunAt,
    lastPick,
    createdAt: row.createdAt,
  };
}

function ownSchedule(id: number, userId: number, isAdmin: boolean) {
  const row = db.select().from(scheduledPicks).where(eq(scheduledPicks.id, id)).get();
  if (!row) return null;
  if (row.createdBy !== userId && !isAdmin) return null;
  return row;
}

export async function scheduleRoutes(app: FastifyInstance) {
  app.get('/api/schedules', { preHandler: requireUser }, async (request) => {
    return db
      .select()
      .from(scheduledPicks)
      .where(eq(scheduledPicks.createdBy, request.user!.id))
      .orderBy(desc(scheduledPicks.createdAt))
      .all()
      .map(serializeSchedule);
  });

  app.post('/api/schedules', { preHandler: requireUser }, async (request, reply) => {
    const parsed = z
      .object({
        name: z.string().min(1, 'Name is required').max(100),
        kind: z.enum(['weekly', 'once']),
        dayOfWeek: z.number().int().min(0).max(6).optional(),
        timeOfDay: z.string().regex(/^\d{2}:\d{2}$/, 'Time must be HH:MM').optional(),
        runAt: z.string().optional(),
        filters: randomFiltersSchema.default({}),
        postToDiscord: z.boolean().default(true),
      })
      .safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid request' });
    const data = parsed.data;

    let runAt: Date | null = null;
    if (data.kind === 'weekly') {
      if (data.dayOfWeek === undefined || !data.timeOfDay) {
        return reply.code(400).send({ error: 'Weekly schedules need a day and a time' });
      }
    } else {
      runAt = data.runAt ? new Date(data.runAt) : null;
      if (!runAt || Number.isNaN(runAt.getTime())) {
        return reply.code(400).send({ error: 'One-time schedules need a valid date and time' });
      }
    }

    const row = db
      .insert(scheduledPicks)
      .values({
        name: data.name,
        createdBy: request.user!.id,
        kind: data.kind,
        dayOfWeek: data.kind === 'weekly' ? data.dayOfWeek : null,
        timeOfDay: data.kind === 'weekly' ? data.timeOfDay : null,
        runAt,
        filters: JSON.stringify(data.filters),
        postToDiscord: data.postToDiscord,
      })
      .returning()
      .get();
    return reply.code(201).send(serializeSchedule(row));
  });

  app.patch('/api/schedules/:id', { preHandler: requireUser }, async (request, reply) => {
    const row = ownSchedule(Number((request.params as { id: string }).id), request.user!.id, request.user!.isAdmin);
    if (!row) return reply.code(404).send({ error: 'Schedule not found' });
    const parsed = z.object({ enabled: z.boolean() }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid request' });
    db.update(scheduledPicks).set({ enabled: parsed.data.enabled }).where(eq(scheduledPicks.id, row.id)).run();
    return serializeSchedule(db.select().from(scheduledPicks).where(eq(scheduledPicks.id, row.id)).get()!);
  });

  app.delete('/api/schedules/:id', { preHandler: requireUser }, async (request, reply) => {
    const row = ownSchedule(Number((request.params as { id: string }).id), request.user!.id, request.user!.isAdmin);
    if (!row) return reply.code(404).send({ error: 'Schedule not found' });
    db.delete(scheduledPicks).where(eq(scheduledPicks.id, row.id)).run();
    return reply.code(204).send();
  });

  // Run right now, regardless of the schedule. Returns the pick.
  app.post('/api/schedules/:id/run', { preHandler: requireUser }, async (request, reply) => {
    const row = ownSchedule(Number((request.params as { id: string }).id), request.user!.id, request.user!.isAdmin);
    if (!row) return reply.code(404).send({ error: 'Schedule not found' });
    const pick = await runSchedule(row);
    if (!pick) return reply.code(404).send({ error: 'No titles match this schedule’s filters' });
    return serializeMedia(pick);
  });
}
