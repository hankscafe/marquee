import crypto from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { and, eq, gt } from 'drizzle-orm';
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
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

export async function createSession(reply: FastifyReply, userId: number) {
  const token = crypto.randomBytes(32).toString('hex');
  db.insert(sessions)
    .values({ token, userId, expiresAt: new Date(Date.now() + SESSION_TTL_MS) })
    .run();
  reply.setCookie(COOKIE_NAME, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    signed: true,
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
  app.addHook('onRequest', async (request) => {
    const raw = request.cookies[COOKIE_NAME];
    if (!raw) return;
    const unsigned = request.unsignCookie(raw);
    if (!unsigned.valid || !unsigned.value) return;
    const row = db
      .select({ id: users.id, username: users.username, isAdmin: users.isAdmin })
      .from(sessions)
      .innerJoin(users, eq(sessions.userId, users.id))
      .where(and(eq(sessions.token, unsigned.value), gt(sessions.expiresAt, new Date())))
      .get();
    if (row) request.user = row;
  });
});

export async function requireUser(request: FastifyRequest, reply: FastifyReply) {
  if (!request.user) return reply.code(401).send({ error: 'Authentication required' });
}

export async function requireAdmin(request: FastifyRequest, reply: FastifyReply) {
  if (!request.user) return reply.code(401).send({ error: 'Authentication required' });
  if (!request.user.isAdmin) return reply.code(403).send({ error: 'Admin access required' });
}
