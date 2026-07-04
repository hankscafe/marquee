import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { and, eq, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.js';
import { listItems, lists, media, users } from '../db/schema.js';
import { requireUser } from '../auth/plugin.js';
import { serializeMedia } from './media.js';

function listById(id: number) {
  return db.select().from(lists).where(eq(lists.id, id)).get();
}

function canView(list: typeof lists.$inferSelect, user: { id: number; isAdmin: boolean }) {
  return list.isShared || list.ownerId === user.id || user.isAdmin;
}

function canEdit(list: typeof lists.$inferSelect, user: { id: number; isAdmin: boolean }) {
  return list.ownerId === user.id || user.isAdmin;
}

function serializeList(list: typeof lists.$inferSelect, userId: number) {
  const owner = db.select({ username: users.username }).from(users).where(eq(users.id, list.ownerId)).get();
  const itemCount = db
    .select({ c: sql<number>`count(*)` })
    .from(listItems)
    .where(eq(listItems.listId, list.id))
    .get()!.c;
  return {
    id: list.id,
    name: list.name,
    ownerId: list.ownerId,
    ownerName: owner?.username ?? 'unknown',
    isShared: list.isShared,
    isOwner: list.ownerId === userId,
    itemCount,
  };
}

export async function listRoutes(app: FastifyInstance) {
  // My lists plus lists other users have shared.
  app.get('/api/lists', { preHandler: requireUser }, async (request) => {
    const rows = db
      .select()
      .from(lists)
      .where(or(eq(lists.ownerId, request.user!.id), eq(lists.isShared, true)))
      .all();
    return rows.map((l) => serializeList(l, request.user!.id));
  });

  app.post('/api/lists', { preHandler: requireUser }, async (request, reply) => {
    const parsed = z
      .object({ name: z.string().min(1, 'Name is required').max(100), isShared: z.boolean().default(false) })
      .safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid request' });
    const list = db
      .insert(lists)
      .values({ name: parsed.data.name, ownerId: request.user!.id, isShared: parsed.data.isShared })
      .returning()
      .get();
    return reply.code(201).send(serializeList(list, request.user!.id));
  });

  app.get('/api/lists/:id', { preHandler: requireUser }, async (request, reply) => {
    const list = listById(Number((request.params as { id: string }).id));
    if (!list || !canView(list, request.user!)) return reply.code(404).send({ error: 'List not found' });
    const items = db
      .select({ media })
      .from(listItems)
      .innerJoin(media, eq(listItems.mediaId, media.id))
      .where(eq(listItems.listId, list.id))
      .all()
      .map((r) => serializeMedia(r.media));
    return { ...serializeList(list, request.user!.id), items };
  });

  app.patch('/api/lists/:id', { preHandler: requireUser }, async (request, reply) => {
    const list = listById(Number((request.params as { id: string }).id));
    if (!list || !canView(list, request.user!)) return reply.code(404).send({ error: 'List not found' });
    if (!canEdit(list, request.user!)) return reply.code(403).send({ error: 'Only the list owner can do that' });
    const parsed = z
      .object({ name: z.string().min(1).max(100).optional(), isShared: z.boolean().optional() })
      .safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid request' });
    db.update(lists).set(parsed.data).where(eq(lists.id, list.id)).run();
    return serializeList(listById(list.id)!, request.user!.id);
  });

  app.delete('/api/lists/:id', { preHandler: requireUser }, async (request, reply) => {
    const list = listById(Number((request.params as { id: string }).id));
    if (!list || !canView(list, request.user!)) return reply.code(404).send({ error: 'List not found' });
    if (!canEdit(list, request.user!)) return reply.code(403).send({ error: 'Only the list owner can do that' });
    db.delete(lists).where(eq(lists.id, list.id)).run();
    return reply.code(204).send();
  });

  app.post('/api/lists/:id/items', { preHandler: requireUser }, async (request, reply) => {
    const list = listById(Number((request.params as { id: string }).id));
    if (!list || !canView(list, request.user!)) return reply.code(404).send({ error: 'List not found' });
    if (!canEdit(list, request.user!)) return reply.code(403).send({ error: 'Only the list owner can do that' });
    const parsed = z.object({ mediaId: z.number().int() }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid request' });
    const item = db.select().from(media).where(eq(media.id, parsed.data.mediaId)).get();
    if (!item) return reply.code(404).send({ error: 'Media not found' });
    db.insert(listItems)
      .values({ listId: list.id, mediaId: item.id })
      .onConflictDoNothing()
      .run();
    return reply.code(201).send({ ok: true });
  });

  app.delete('/api/lists/:id/items/:mediaId', { preHandler: requireUser }, async (request, reply) => {
    const params = request.params as { id: string; mediaId: string };
    const list = listById(Number(params.id));
    if (!list || !canView(list, request.user!)) return reply.code(404).send({ error: 'List not found' });
    if (!canEdit(list, request.user!)) return reply.code(403).send({ error: 'Only the list owner can do that' });
    db.delete(listItems)
      .where(and(eq(listItems.listId, list.id), eq(listItems.mediaId, Number(params.mediaId))))
      .run();
    return reply.code(204).send();
  });

  app.post('/api/lists/:id/random', { preHandler: requireUser }, async (request, reply) => {
    const list = listById(Number((request.params as { id: string }).id));
    if (!list || !canView(list, request.user!)) return reply.code(404).send({ error: 'List not found' });
    const items = db
      .select({ media })
      .from(listItems)
      .innerJoin(media, eq(listItems.mediaId, media.id))
      .where(eq(listItems.listId, list.id))
      .all();
    if (!items.length) return reply.code(404).send({ error: 'This list is empty' });
    return serializeMedia(items[crypto.randomInt(items.length)]!.media);
  });
}
