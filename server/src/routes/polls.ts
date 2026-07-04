import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { and, desc, eq, ne, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.js';
import { media, pollOptions, polls, votes } from '../db/schema.js';
import { requireUser } from '../auth/plugin.js';
import { postPollToDiscord, updatePollMessage } from '../discord/bot.js';
import { emitPollUpdate, pollEvents } from '../events.js';
import { closePoll, getOptionCounts, serializePollDetail } from '../polls/service.js';

const createPollSchema = z.object({
  title: z.string().min(1, 'Title is required').max(200),
  description: z.string().max(2000).optional(),
  mediaIds: z.array(z.number().int()).min(2, 'Pick at least two options').max(50),
  opensAt: z.string().optional(),
  closesAt: z.string().optional(),
  openNow: z.boolean().default(true),
});

function parseDate(value?: string): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function pollByToken(token: string) {
  return db.select().from(polls).where(eq(polls.shareToken, token)).get();
}

function canManage(poll: typeof polls.$inferSelect, user: { id: number; isAdmin: boolean }) {
  return poll.createdBy === user.id || user.isAdmin;
}

export async function pollRoutes(app: FastifyInstance) {
  app.get('/api/polls', { preHandler: requireUser }, async (request) => {
    const userId = request.user!.id;
    // Everyone sees open/closed polls; drafts are visible only to their creator.
    const rows = db
      .select()
      .from(polls)
      .where(or(eq(polls.createdBy, userId), ne(polls.status, 'draft')))
      .orderBy(desc(polls.createdAt))
      .limit(100)
      .all();
    return rows.map((p) => {
      const optionCount = db
        .select({ c: sql<number>`count(*)` })
        .from(pollOptions)
        .where(eq(pollOptions.pollId, p.id))
        .get()!.c;
      const voteCount = db
        .select({ c: sql<number>`count(*)` })
        .from(votes)
        .where(eq(votes.pollId, p.id))
        .get()!.c;
      return {
        id: p.id,
        title: p.title,
        status: p.status,
        shareToken: p.shareToken,
        isOwner: p.createdBy === userId,
        optionCount,
        voteCount,
        closesAt: p.closesAt,
        createdAt: p.createdAt,
      };
    });
  });

  app.post('/api/polls', { preHandler: requireUser }, async (request, reply) => {
    const parsed = createPollSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid request' });
    const { title, description, mediaIds, opensAt, closesAt, openNow } = parsed.data;

    const items = mediaIds
      .map((id) => db.select().from(media).where(eq(media.id, id)).get())
      .filter((m): m is typeof media.$inferSelect => !!m);
    if (items.length < 2) return reply.code(400).send({ error: 'A poll needs at least two valid options' });

    const poll = db
      .insert(polls)
      .values({
        title,
        description: description || null,
        shareToken: crypto.randomBytes(9).toString('base64url'),
        status: openNow ? 'open' : 'draft',
        createdBy: request.user!.id,
        opensAt: parseDate(opensAt),
        closesAt: parseDate(closesAt),
      })
      .returning()
      .get();

    for (const m of items) {
      db.insert(pollOptions)
        .values({
          pollId: poll.id,
          mediaId: m.id,
          title: m.year ? `${m.title} (${m.year})` : m.title,
          thumb: m.thumb,
        })
        .run();
    }

    return reply.code(201).send(serializePollDetail(poll, request.user!.id));
  });

  app.get('/api/polls/:token', { preHandler: requireUser }, async (request, reply) => {
    const { token } = request.params as { token: string };
    const poll = pollByToken(token);
    if (!poll) return reply.code(404).send({ error: 'Poll not found' });
    if (poll.status === 'draft' && !canManage(poll, request.user!)) {
      return reply.code(404).send({ error: 'Poll not found' });
    }
    return serializePollDetail(poll, request.user!.id);
  });

  app.post('/api/polls/:token/vote', { preHandler: requireUser }, async (request, reply) => {
    const { token } = request.params as { token: string };
    const parsed = z.object({ optionId: z.number().int() }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid request' });

    const poll = pollByToken(token);
    if (!poll) return reply.code(404).send({ error: 'Poll not found' });
    if (poll.status !== 'open') return reply.code(409).send({ error: 'This poll is not open for voting' });
    const option = db
      .select()
      .from(pollOptions)
      .where(and(eq(pollOptions.id, parsed.data.optionId), eq(pollOptions.pollId, poll.id)))
      .get();
    if (!option) return reply.code(400).send({ error: 'That option does not belong to this poll' });

    try {
      db.insert(votes).values({ pollId: poll.id, optionId: option.id, userId: request.user!.id }).run();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('UNIQUE')) {
        return reply.code(409).send({ error: 'You have already voted in this poll' });
      }
      throw err;
    }

    emitPollUpdate(token);
    void updatePollMessage(poll.id);
    return serializePollDetail(poll, request.user!.id);
  });

  // Post this poll to the configured Discord channel with vote buttons.
  app.post('/api/polls/:token/discord', { preHandler: requireUser }, async (request, reply) => {
    const { token } = request.params as { token: string };
    const poll = pollByToken(token);
    if (!poll) return reply.code(404).send({ error: 'Poll not found' });
    if (!canManage(poll, request.user!)) return reply.code(403).send({ error: 'Only the poll owner can do that' });
    try {
      await postPollToDiscord(poll.id);
      return serializePollDetail(pollByToken(token)!, request.user!.id);
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : 'Could not post to Discord' });
    }
  });

  app.post('/api/polls/:token/open', { preHandler: requireUser }, async (request, reply) => {
    const { token } = request.params as { token: string };
    const poll = pollByToken(token);
    if (!poll) return reply.code(404).send({ error: 'Poll not found' });
    if (!canManage(poll, request.user!)) return reply.code(403).send({ error: 'Only the poll owner can do that' });
    if (poll.status === 'closed') return reply.code(409).send({ error: 'This poll has already closed' });
    db.update(polls).set({ status: 'open' }).where(eq(polls.id, poll.id)).run();
    emitPollUpdate(token);
    return serializePollDetail(pollByToken(token)!, request.user!.id);
  });

  app.post('/api/polls/:token/close', { preHandler: requireUser }, async (request, reply) => {
    const { token } = request.params as { token: string };
    const poll = pollByToken(token);
    if (!poll) return reply.code(404).send({ error: 'Poll not found' });
    if (!canManage(poll, request.user!)) return reply.code(403).send({ error: 'Only the poll owner can do that' });
    closePoll(poll.id);
    return serializePollDetail(pollByToken(token)!, request.user!.id);
  });

  app.delete('/api/polls/:token', { preHandler: requireUser }, async (request, reply) => {
    const { token } = request.params as { token: string };
    const poll = pollByToken(token);
    if (!poll) return reply.code(404).send({ error: 'Poll not found' });
    if (!canManage(poll, request.user!)) return reply.code(403).send({ error: 'Only the poll owner can do that' });
    db.delete(polls).where(eq(polls.id, poll.id)).run();
    return reply.code(204).send();
  });

  // Live results over Server-Sent Events; clients refetch on each message.
  app.get('/api/polls/:token/events', { preHandler: requireUser }, (request, reply) => {
    const { token } = request.params as { token: string };
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    });
    reply.raw.write('retry: 3000\n\n');

    const channel = `poll:${token}`;
    const listener = (payload: unknown) => reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
    pollEvents.on(channel, listener);
    const heartbeat = setInterval(() => reply.raw.write(': ping\n\n'), 25_000);
    request.raw.on('close', () => {
      clearInterval(heartbeat);
      pollEvents.off(channel, listener);
    });
  });
}
