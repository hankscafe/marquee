import crypto from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { and, eq, gt } from 'drizzle-orm';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { sessions, users } from '../db/schema.js';

export interface SessionUser {
  id: number;
  username: string;
  isAdmin: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    user: SessionUser | null;
  }
}

const COOKIE_NAME = 'marquee_session';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days (absolute cap)
// Only rewrite lastSeenAt when it's this stale, so an active session doesn't
// take a DB write on every single request.
const LAST_SEEN_THROTTLE_MS = 60 * 1000;

// Idle window for a session, in ms, based on the account's role.
export function idleLimitMs(isAdmin: boolean): number {
  return (isAdmin ? config.adminIdleMinutes : config.userIdleMinutes) * 60 * 1000;
}

export async function createSession(reply: FastifyReply, userId: number) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = new Date();
  db.insert(sessions)
    .values({ token, userId, expiresAt: new Date(now.getTime() + SESSION_TTL_MS), lastSeenAt: now })
    .run();
  reply.setCookie(COOKIE_NAME, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    signed: true,
    // Secure when served over TLS (trustProxy makes this reflect X-Forwarded-Proto)
    secure: reply.request.protocol === 'https',
    maxAge: SESSION_TTL_MS / 1000,
  });
}

export function destroySession(request: FastifyRequest, reply: FastifyReply) {
  const raw = request.cookies[COOKIE_NAME];
  if (raw) {
    const unsigned = request.unsignCookie(raw);
    if (unsigned.valid && unsigned.value) {
      db.delete(sessions).where(eq(sessions.token, unsigned.value)).run();
    }
  }
  reply.clearCookie(COOKIE_NAME, { path: '/' });
}

export const authPlugin = fp(async (app: FastifyInstance) => {
  app.decorateRequest('user', null);
  app.addHook('onRequest', async (request, reply) => {
    const raw = request.cookies[COOKIE_NAME];
    if (!raw) return;
    const unsigned = request.unsignCookie(raw);
    if (!unsigned.valid || !unsigned.value) return;
    const token = unsigned.value;
    const now = new Date();
    const row = db
      .select({
        id: users.id,
        username: users.username,
        isAdmin: users.isAdmin,
        lastSeenAt: sessions.lastSeenAt,
      })
      .from(sessions)
      .innerJoin(users, eq(sessions.userId, users.id))
      .where(and(eq(sessions.token, token), gt(sessions.expiresAt, now)))
      .get();
    if (!row) return;

    // Idle auto-logout: if the session has gone untouched longer than the
    // role's window, revoke it and clear the cookie instead of authenticating.
    const lastSeen = row.lastSeenAt ?? now;
    if (now.getTime() - lastSeen.getTime() > idleLimitMs(row.isAdmin)) {
      db.delete(sessions).where(eq(sessions.token, token)).run();
      reply.clearCookie(COOKIE_NAME, { path: '/' });
      return;
    }

    request.user = { id: row.id, username: row.username, isAdmin: row.isAdmin };
    // Refresh activity, throttled to avoid a write per request.
    if (!row.lastSeenAt || now.getTime() - row.lastSeenAt.getTime() > LAST_SEEN_THROTTLE_MS) {
      db.update(sessions).set({ lastSeenAt: now }).where(eq(sessions.token, token)).run();
    }
  });
});

export async function requireUser(request: FastifyRequest, reply: FastifyReply) {
  if (!request.user) return reply.code(401).send({ error: 'Authentication required' });
}

export async function requireAdmin(request: FastifyRequest, reply: FastifyReply) {
  if (!request.user) return reply.code(401).send({ error: 'Authentication required' });
  if (!request.user.isAdmin) return reply.code(403).send({ error: 'Admin access required' });
}
