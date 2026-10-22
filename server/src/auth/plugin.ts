import crypto from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { and, eq, gt, inArray, lt, lte, ne, notInArray, or } from 'drizzle-orm';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { sessions, users } from '../db/schema.js';
import { getAppUrl } from '../settings.js';

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

// Idle window for a session, in minutes, based on the account's role.
export function idleMinutes(isAdmin: boolean): number {
  return isAdmin ? config.adminIdleMinutes : config.userIdleMinutes;
}

// Sessions past their 30-day cap, or idle longer than their account's role
// allows, can never be used again — but the auth hook only notices one when its
// cookie comes back. Run periodically so they don't pile up.
export function pruneSessions(now = new Date()): number {
  const idleSince = (isAdmin: boolean) => new Date(now.getTime() - idleMinutes(isAdmin) * 60_000);
  const admins = db.select({ id: users.id }).from(users).where(eq(users.isAdmin, true));
  return db
    .delete(sessions)
    .where(
      or(
        lte(sessions.expiresAt, now),
        and(inArray(sessions.userId, admins), lt(sessions.lastSeenAt, idleSince(true))),
        and(notInArray(sessions.userId, admins), lt(sessions.lastSeenAt, idleSince(false))),
      ),
    )
    .run().changes;
}

// Whether to mark cookies Secure. A TLS-terminating proxy that forgets
// X-Forwarded-Proto makes an https site look like http, which would hand out
// the session cookie without Secure; so the app URL's scheme decides, and the
// request only when no app URL is set.
export function cookieSecure(request: FastifyRequest): boolean {
  const appUrl = getAppUrl();
  return appUrl ? appUrl.startsWith('https:') : request.protocol === 'https';
}

export async function createSession(reply: FastifyReply, userId: number) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = new Date();
  // This browser is getting a new session, so the one it held before is dead
  // weight — revoke it rather than leave a row that still works.
  const previous = sessionToken(reply.request);
  if (previous) db.delete(sessions).where(eq(sessions.token, previous)).run();
  db.insert(sessions)
    .values({ token, userId, expiresAt: new Date(now.getTime() + SESSION_TTL_MS), lastSeenAt: now })
    .run();
  reply.setCookie(COOKIE_NAME, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    signed: true,
    secure: cookieSecure(reply.request),
    maxAge: SESSION_TTL_MS / 1000,
  });
}

// The session token in this request's signed cookie, if it has a valid one.
function sessionToken(request: FastifyRequest): string | null {
  const raw = request.cookies[COOKIE_NAME];
  if (!raw) return null;
  const unsigned = request.unsignCookie(raw);
  return unsigned.valid && unsigned.value ? unsigned.value : null;
}

export function destroySession(request: FastifyRequest, reply: FastifyReply) {
  const token = sessionToken(request);
  if (token) db.delete(sessions).where(eq(sessions.token, token)).run();
  reply.clearCookie(COOKIE_NAME, { path: '/' });
}

// Sign a user out everywhere except the browser asking — after a password
// change, whoever else held a session is exactly who should lose it.
export function revokeOtherSessions(request: FastifyRequest, userId: number): number {
  const keep = sessionToken(request);
  return db
    .delete(sessions)
    .where(keep ? and(eq(sessions.userId, userId), ne(sessions.token, keep)) : eq(sessions.userId, userId))
    .run().changes;
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
    if (now.getTime() - lastSeen.getTime() > idleMinutes(row.isAdmin) * 60_000) {
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
