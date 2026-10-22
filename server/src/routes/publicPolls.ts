import crypto from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.js';
import { media, pollOptions, polls, users, votes } from '../db/schema.js';
import { cookieSecure, requireAdmin } from '../auth/plugin.js';
import { updatePollMessage } from '../discord/bot.js';
import { emitPollUpdate, streamPollEvents } from '../events.js';
import { serializePollDetail, serializePublicPoll } from '../polls/service.js';
import { GUEST_VOTES_PER_NETWORK, guestUsername, networkFingerprint } from '../polls/guests.js';
import { castVote } from '../polls/votes.js';
import { streamPoster } from './media.js';

// Public poll links: an admin can share a poll at /vote/<publicToken> so people
// without a Marquee account can vote. Each browser gets a guest account (like
// the Discord bot's shadow accounts), so the votes table's one-vote-per-account
// rule still applies. Guests also give a name, and a name can only vote once
// per poll; each network is capped too (see polls/guests.ts). Signed-in
// visitors vote as themselves.

const VOTER_COOKIE = 'marquee_voter';
const VOTER_COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // a year, in seconds

// These endpoints need no login, so they're rate-limited per IP. Reads allow
// for a household on one connection all watching live results.
const READ_RATE = { rateLimit: { max: 300, timeWindow: '1 minute' } };
const VOTE_RATE = { rateLimit: { max: 20, timeWindow: '1 minute' } };
const POSTER_RATE = { rateLimit: { max: 600, timeWindow: '1 minute' } };

// Drafts stay private even if they have a public link.
function publicPoll(publicToken: string, reply: FastifyReply) {
  const poll = db.select().from(polls).where(eq(polls.publicToken, publicToken)).get();
  if (!poll) {
    reply.code(404).send({ error: 'This poll link is no longer shared' });
    return null;
  }
  if (poll.status === 'draft') {
    reply.code(404).send({ error: "This poll isn't open for voting yet" });
    return null;
  }
  return poll;
}

// The guest id in this browser's signed voter cookie, if it has one.
function readGuestId(request: FastifyRequest): string | null {
  const raw = request.cookies[VOTER_COOKIE];
  if (!raw) return null;
  const unsigned = request.unsignCookie(raw);
  return unsigned.valid && unsigned.value ? unsigned.value : null;
}

// Who is voting: the signed-in account, else this browser's guest account (once it has one).
function currentVoterId(request: FastifyRequest): number | null {
  if (request.user) return request.user.id;
  const guestId = readGuestId(request);
  if (!guestId) return null;
  return db.select({ id: users.id }).from(users).where(eq(users.guestId, guestId)).get()?.id ?? null;
}

// This browser's guest account, created (and the cookie set) on its first vote.
// Its username is internal; the name the guest typed is kept on their vote.
function guestAccountId(request: FastifyRequest, reply: FastifyReply): number {
  const guestId = readGuestId(request) ?? crypto.randomBytes(16).toString('hex');
  const existing = db.select({ id: users.id }).from(users).where(eq(users.guestId, guestId)).get();
  if (existing) return existing.id;
  reply.setCookie(VOTER_COOKIE, guestId, {
    path: '/api/public',
    httpOnly: true,
    sameSite: 'lax',
    signed: true,
    secure: cookieSecure(request),
    maxAge: VOTER_COOKIE_MAX_AGE,
  });
  return db
    .insert(users)
    .values({ username: guestUsername(guestId), passwordHash: null, guestId })
    .returning({ id: users.id })
    .get().id;
}

export async function publicPollRoutes(app: FastifyInstance) {
  // Admins can share a poll at a public link that needs no login, or stop sharing it.
  // Stopping clears the token, so the old link stops working for good.
  app.post('/api/polls/:token/public', { preHandler: requireAdmin }, async (request, reply) => {
    const { token } = request.params as { token: string };
    const parsed = z.object({ enabled: z.boolean() }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid request' });
    const poll = db.select().from(polls).where(eq(polls.shareToken, token)).get();
    if (!poll) return reply.code(404).send({ error: 'Poll not found' });
    const publicToken = parsed.data.enabled ? (poll.publicToken ?? crypto.randomBytes(12).toString('base64url')) : null;
    db.update(polls).set({ publicToken }).where(eq(polls.id, poll.id)).run();
    return serializePollDetail(db.select().from(polls).where(eq(polls.id, poll.id)).get()!, request.user!);
  });

  app.get('/api/public/polls/:publicToken', { config: READ_RATE }, async (request, reply) => {
    const { publicToken } = request.params as { publicToken: string };
    const poll = publicPoll(publicToken, reply);
    if (!poll) return reply;
    return serializePublicPoll(poll, currentVoterId(request), !!request.user);
  });

  app.post('/api/public/polls/:publicToken/vote', { config: VOTE_RATE }, async (request, reply) => {
    const { publicToken } = request.params as { publicToken: string };
    const parsed = z
      .object({ optionId: z.number().int(), name: z.string().trim().max(40, 'Keep your name under 40 characters').optional() })
      .safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid request' });
    const poll = publicPoll(publicToken, reply);
    if (!poll) return reply;
    if (poll.status !== 'open') return reply.code(409).send({ error: 'Voting is closed for this poll' });
    const option = db
      .select()
      .from(pollOptions)
      .where(and(eq(pollOptions.id, parsed.data.optionId), eq(pollOptions.pollId, poll.id)))
      .get();
    if (!option) return reply.code(400).send({ error: 'That option does not belong to this poll' });

    const alreadyVoted = (userId: number | null) =>
      userId !== null &&
      !!db.select({ id: votes.id }).from(votes).where(and(eq(votes.pollId, poll.id), eq(votes.userId, userId))).get();
    if (alreadyVoted(currentVoterId(request))) {
      return reply.code(409).send({ error: 'You have already voted in this poll' });
    }

    let userId: number;
    let voterName: string | null = null;
    let voterNetwork: string | null = null;
    if (request.user) {
      userId = request.user.id;
    } else {
      voterName = parsed.data.name ?? '';
      if (!voterName) return reply.code(400).send({ error: 'Enter your name to vote' });
      const nameTaken = db
        .select({ id: votes.id })
        .from(votes)
        .where(and(eq(votes.pollId, poll.id), sql`lower(${votes.voterName}) = lower(${voterName})`))
        .get();
      if (nameTaken) {
        return reply.code(409).send({ error: 'That name is already taken in this poll — add an initial or a nickname' });
      }
      voterNetwork = networkFingerprint(request.ip);
      const fromNetwork = db
        .select({ n: sql<number>`count(*)` })
        .from(votes)
        .where(and(eq(votes.pollId, poll.id), eq(votes.voterNetwork, voterNetwork)))
        .get()!.n;
      if (fromNetwork >= GUEST_VOTES_PER_NETWORK) {
        return reply.code(429).send({ error: 'Lots of guests have already voted from your network on this poll — sign in to vote' });
      }
      userId = guestAccountId(request, reply);
    }

    if (!castVote({ pollId: poll.id, optionId: option.id, userId, voterName, voterNetwork })) {
      return reply.code(409).send({ error: 'You have already voted in this poll' });
    }

    emitPollUpdate(poll.shareToken);
    updatePollMessage(poll.id);
    return serializePublicPoll(poll, userId, !!request.user);
  });

  // Live results, same as the signed-in poll page.
  app.get('/api/public/polls/:publicToken/events', { config: READ_RATE }, (request, reply) => {
    const { publicToken } = request.params as { publicToken: string };
    const poll = publicPoll(publicToken, reply);
    if (!poll) return reply;
    streamPollEvents(request, reply, poll.shareToken);
  });

  // Posters for this poll's options only — a public link never opens up the rest of the library.
  app.get('/api/public/polls/:publicToken/options/:optionId/poster', { config: POSTER_RATE }, async (request, reply) => {
    const { publicToken, optionId } = request.params as { publicToken: string; optionId: string };
    const poll = publicPoll(publicToken, reply);
    if (!poll) return reply;
    const option = db
      .select({ mediaId: pollOptions.mediaId })
      .from(pollOptions)
      .where(and(eq(pollOptions.id, Number(optionId)), eq(pollOptions.pollId, poll.id)))
      .get();
    const item = option?.mediaId ? db.select().from(media).where(eq(media.id, option.mediaId)).get() : undefined;
    if (!item) return reply.code(404).send({ error: 'No poster available' });
    return streamPoster(item, reply, 'private, max-age=86400');
  });
}
