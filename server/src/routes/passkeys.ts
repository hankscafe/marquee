import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { isoBase64URL, isoUint8Array } from '@simplewebauthn/server/helpers';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.js';
import { passkeys, users } from '../db/schema.js';
import { createSession, requireUser } from '../auth/plugin.js';
import { getSetting } from '../settings.js';

// WebAuthn passkeys: any signed-in user can register one from the Account page;
// the login page then offers usernameless (discoverable-credential) sign-in.

const CHALLENGE_COOKIE = 'marquee_webauthn';

// The relying-party id/origin must match what the browser sees. Prefer the
// admin-configured public URL; fall back to the request's own host (dev).
function rpContext(request: FastifyRequest): { origin: string; rpID: string } {
  const appUrl = getSetting('app.url');
  const origin = appUrl ? appUrl.replace(/\/+$/, '') : `${request.protocol}://${request.headers.host}`;
  return { origin, rpID: new URL(origin).hostname };
}

function setChallenge(reply: FastifyReply, kind: 'reg' | 'auth', challenge: string) {
  reply.setCookie(CHALLENGE_COOKIE, JSON.stringify({ kind, challenge }), {
    path: '/api',
    httpOnly: true,
    sameSite: 'lax',
    signed: true,
    maxAge: 300,
  });
}

function takeChallenge(request: FastifyRequest, reply: FastifyReply, kind: 'reg' | 'auth'): string | null {
  const raw = request.cookies[CHALLENGE_COOKIE];
  reply.clearCookie(CHALLENGE_COOKIE, { path: '/api' });
  if (!raw) return null;
  const unsigned = request.unsignCookie(raw);
  if (!unsigned.valid || !unsigned.value) return null;
  try {
    const parsed = JSON.parse(unsigned.value) as { kind: string; challenge: string };
    return parsed.kind === kind ? parsed.challenge : null;
  } catch {
    return null;
  }
}

export async function passkeyRoutes(app: FastifyInstance) {
  app.get('/api/passkeys', { preHandler: requireUser }, async (request) => {
    return db
      .select({
        id: passkeys.id,
        name: passkeys.name,
        createdAt: passkeys.createdAt,
        lastUsedAt: passkeys.lastUsedAt,
      })
      .from(passkeys)
      .where(eq(passkeys.userId, request.user!.id))
      .all();
  });

  app.post('/api/passkeys/register/options', { preHandler: requireUser }, async (request, reply) => {
    const { rpID } = rpContext(request);
    const existing = db.select().from(passkeys).where(eq(passkeys.userId, request.user!.id)).all();
    const options = await generateRegistrationOptions({
      rpName: 'Marquee',
      rpID,
      userName: request.user!.username,
      userID: isoUint8Array.fromUTF8String(`marquee-user-${request.user!.id}`),
      attestationType: 'none',
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
      excludeCredentials: existing.map((c) => ({
        id: c.credentialId,
        transports: c.transports ? (JSON.parse(c.transports) as never[]) : undefined,
      })),
    });
    setChallenge(reply, 'reg', options.challenge);
    return options;
  });

  app.post('/api/passkeys/register/verify', { preHandler: requireUser }, async (request, reply) => {
    const parsed = z
      .object({ name: z.string().max(60).optional(), response: z.unknown() })
      .safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid request' });
    const expectedChallenge = takeChallenge(request, reply, 'reg');
    if (!expectedChallenge) return reply.code(400).send({ error: 'Registration session expired — try again' });

    const { origin, rpID } = rpContext(request);
    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response: parsed.data.response as RegistrationResponseJSON,
        expectedChallenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
      });
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : 'Passkey verification failed' });
    }
    if (!verification.verified || !verification.registrationInfo) {
      return reply.code(400).send({ error: 'Passkey could not be verified' });
    }

    const cred = verification.registrationInfo.credential;
    db.insert(passkeys)
      .values({
        userId: request.user!.id,
        credentialId: cred.id,
        publicKey: isoBase64URL.fromBuffer(cred.publicKey),
        counter: cred.counter,
        transports: cred.transports ? JSON.stringify(cred.transports) : null,
        name: parsed.data.name?.trim() || 'Passkey',
      })
      .onConflictDoNothing()
      .run();
    return reply.code(201).send({ ok: true });
  });

  app.delete('/api/passkeys/:id', { preHandler: requireUser }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const row = db
      .select()
      .from(passkeys)
      .where(and(eq(passkeys.id, id), eq(passkeys.userId, request.user!.id)))
      .get();
    if (!row) return reply.code(404).send({ error: 'Passkey not found' });
    db.delete(passkeys).where(eq(passkeys.id, row.id)).run();
    return reply.code(204).send();
  });

  // Login step 1: authentication options with no allowCredentials — the browser
  // offers whatever discoverable credentials it holds for this site.
  app.post('/api/auth/passkey/options', async (request, reply) => {
    const { rpID } = rpContext(request);
    const options = await generateAuthenticationOptions({ rpID, userVerification: 'preferred' });
    setChallenge(reply, 'auth', options.challenge);
    return options;
  });

  // Login step 2: verify the assertion and start a session.
  app.post('/api/auth/passkey/verify', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    const expectedChallenge = takeChallenge(request, reply, 'auth');
    if (!expectedChallenge) return reply.code(400).send({ error: 'Sign-in session expired — try again' });
    const response = request.body as AuthenticationResponseJSON;
    if (!response?.id) return reply.code(400).send({ error: 'Invalid request' });

    const cred = db.select().from(passkeys).where(eq(passkeys.credentialId, response.id)).get();
    if (!cred) return reply.code(401).send({ error: 'Unknown passkey' });

    const { origin, rpID } = rpContext(request);
    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        credential: {
          id: cred.credentialId,
          publicKey: isoBase64URL.toBuffer(cred.publicKey),
          counter: cred.counter,
          transports: cred.transports ? (JSON.parse(cred.transports) as never[]) : undefined,
        },
      });
    } catch (err) {
      return reply.code(401).send({ error: err instanceof Error ? err.message : 'Passkey sign-in failed' });
    }
    if (!verification.verified) return reply.code(401).send({ error: 'Passkey could not be verified' });

    db.update(passkeys)
      .set({ counter: verification.authenticationInfo.newCounter, lastUsedAt: new Date() })
      .where(eq(passkeys.id, cred.id))
      .run();
    const user = db.select().from(users).where(eq(users.id, cred.userId)).get();
    if (!user) return reply.code(401).send({ error: 'Account no longer exists' });
    await createSession(reply, user.id);
    return { user: { id: user.id, username: user.username, isAdmin: user.isAdmin } };
  });
}
