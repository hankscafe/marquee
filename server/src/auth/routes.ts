import crypto from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { eq, sql } from 'drizzle-orm';
import * as oidc from 'openid-client';
import { z } from 'zod';
import { getOidcConfiguration, getOidcSettings, oidcRedirectUri } from './oidc.js';
import { encryptSecret } from '../crypto.js';
import { db } from '../db/index.js';
import { users } from '../db/schema.js';
import { authenticateJf, getJfConfig } from '../jellyfin/client.js';
import { logger } from '../logger.js';
import { buildAuthUrl, checkLoginPin, createLoginPin, getPlexAccount, getServerAccessToken } from '../plex/plextv.js';
import { getAppUrl, getPlexConfig, registrationOpen } from '../settings.js';
import { hashPassword, needsRehash, verifyPassword } from './passwords.js';
import { createSession, destroySession, idleMinutes, requireUser, revokeOtherSessions } from './plugin.js';
import { recordFailure, recordSuccess, retryAfterSeconds, type ThrottleProvider } from './throttle.js';
import { uniqueUsername, usernameIs, usernameTaken } from './usernames.js';

const credentialsSchema = z.object({
  username: z
    .string()
    .min(3, 'Username must be at least 3 characters')
    .max(32, 'Username must be at most 32 characters')
    .regex(/^[a-zA-Z0-9._-]+$/, 'Username may only contain letters, numbers, dots, dashes, and underscores'),
  password: z.string().min(8, 'Password must be at least 8 characters').max(200),
});

// Per-IP brute-force protection on credential endpoints. Behind a loosely
// trusted proxy a client can pick its own request.ip (see config.ts), so the
// per-account backoff in throttle.ts is the control that really counts.
const AUTH_RATE = { rateLimit: { max: 10, timeWindow: '1 minute' } };
// The Plex login page polls every 3s (20/min); leave room for a few people on one connection.
const PLEX_POLL_RATE = { rateLimit: { max: 120, timeWindow: '1 minute' } };
const PLEX_PIN_COOKIE = 'marquee_plex_pin';
// The login page gives up polling after 5 minutes; a PIN binding that outlives
// the attempt only lengthens the window for collecting an approval.
const PLEX_PIN_COOKIE_MAX_AGE = 5 * 60;

// A throwaway hash so login spends the same scrypt time whether or not the
// username exists — closes the timing side channel that would otherwise let an
// attacker enumerate valid local accounts. Written at the current cost.
const DUMMY_PASSWORD_HASH = hashPassword(crypto.randomBytes(16).toString('hex'));

function userCount(): number {
  return db.select({ c: sql<number>`count(*)` }).from(users).get()!.c;
}

// Refuse early while this account is in backoff. Unknown usernames back off
// too, so the answer is the same either way and can't confirm an account exists.
function throttled(provider: ThrottleProvider, username: string, reply: FastifyReply): boolean {
  const retryAfter = retryAfterSeconds(provider, username);
  if (retryAfter === 0) return false;
  const wait = retryAfter < 60 ? `${retryAfter} second${retryAfter === 1 ? '' : 's'}` : `${Math.ceil(retryAfter / 60)} minutes`;
  reply
    .code(429)
    .header('retry-after', String(retryAfter))
    .send({ error: `Too many failed sign-in attempts — try again in ${wait}` });
  return true;
}

export async function authRoutes(app: FastifyInstance) {
  app.get('/api/auth/status', async (request) => {
    return {
      needsSetup: userCount() === 0,
      user: request.user,
      idleTimeoutMinutes: request.user ? idleMinutes(request.user.isAdmin) : null,
      authMethods: {
        plex: !!getPlexConfig(),
        jellyfin: !!getJfConfig('jellyfin'),
        emby: !!getJfConfig('emby'),
        oidc: !!getOidcSettings(),
        oidcLabel: getOidcSettings()?.label ?? null,
        allowRegistration: registrationOpen(),
      },
    };
  });

  // First-run: create the initial admin account.
  app.post('/api/auth/setup', { config: AUTH_RATE }, async (request, reply) => {
    if (userCount() > 0) return reply.code(403).send({ error: 'Setup has already been completed' });
    const parsed = credentialsSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid request' });
    const user = db
      .insert(users)
      .values({
        username: parsed.data.username,
        passwordHash: await hashPassword(parsed.data.password),
        isAdmin: true,
      })
      .returning({ id: users.id, username: users.username, isAdmin: users.isAdmin })
      .get();
    await createSession(reply, user.id);
    return reply.code(201).send({ user });
  });

  app.post('/api/auth/register', { config: AUTH_RATE }, async (request, reply) => {
    if (userCount() === 0) return reply.code(400).send({ error: 'Use setup to create the first admin account' });
    if (!registrationOpen()) {
      return reply.code(403).send({ error: 'Registration is disabled on this server — ask your admin for an account' });
    }
    const parsed = credentialsSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid request' });
    if (usernameTaken(parsed.data.username)) return reply.code(409).send({ error: 'That username is already taken' });
    const user = db
      .insert(users)
      .values({ username: parsed.data.username, passwordHash: await hashPassword(parsed.data.password) })
      .returning({ id: users.id, username: users.username, isAdmin: users.isAdmin })
      .get();
    await createSession(reply, user.id);
    return reply.code(201).send({ user });
  });

  app.post('/api/auth/login', { config: AUTH_RATE }, async (request, reply) => {
    const parsed = z.object({ username: z.string(), password: z.string() }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid request' });
    if (throttled('local', parsed.data.username, reply)) return reply;
    const user = db.select().from(users).where(usernameIs(parsed.data.username)).get();
    // Always verify against a hash (a dummy one when the account is missing or
    // has no local password) so response time doesn't reveal which usernames exist.
    const passwordOk = await verifyPassword(parsed.data.password, user?.passwordHash ?? (await DUMMY_PASSWORD_HASH));
    if (!user?.passwordHash || !passwordOk) {
      // An old, cheaper hash answers noticeably sooner than the dummy, which
      // would give the account away; spend the difference.
      if (user?.passwordHash && needsRehash(user.passwordHash)) {
        await verifyPassword(parsed.data.password, await DUMMY_PASSWORD_HASH);
      }
      recordFailure('local', parsed.data.username);
      logger.warn({ username: parsed.data.username, ip: request.ip }, 'failed login attempt');
      return reply.code(401).send({ error: 'Invalid username or password' });
    }
    recordSuccess('local', parsed.data.username);
    // The only moment the plaintext exists: bring an old-cost hash up to date.
    // A failure here must not fail the sign-in.
    if (needsRehash(user.passwordHash)) {
      try {
        db.update(users).set({ passwordHash: await hashPassword(parsed.data.password) }).where(eq(users.id, user.id)).run();
      } catch (err) {
        logger.warn({ userId: user.id, err }, 'could not upgrade password hash');
      }
    }
    await createSession(reply, user.id);
    return { user: { id: user.id, username: user.username, isAdmin: user.isAdmin } };
  });

  // Change your own password. Needs the current one, and signs every other
  // browser out so a stolen session can't outlive the change.
  app.post('/api/auth/password', { config: AUTH_RATE, preHandler: requireUser }, async (request, reply) => {
    const parsed = z
      .object({ currentPassword: z.string(), newPassword: credentialsSchema.shape.password })
      .safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid request' });
    const user = db.select().from(users).where(eq(users.id, request.user!.id)).get();
    if (!user?.passwordHash) {
      return reply.code(409).send({ error: 'This account signs in without a password — ask your admin to set one' });
    }
    if (throttled('local', user.username, reply)) return reply;
    if (!(await verifyPassword(parsed.data.currentPassword, user.passwordHash))) {
      recordFailure('local', user.username);
      logger.warn({ userId: user.id, ip: request.ip }, 'failed password change attempt');
      return reply.code(401).send({ error: 'That current password isn’t right' });
    }
    recordSuccess('local', user.username);
    db.update(users).set({ passwordHash: await hashPassword(parsed.data.newPassword) }).where(eq(users.id, user.id)).run();
    const revoked = revokeOtherSessions(request, user.id);
    logger.info({ userId: user.id, revoked }, 'password changed');
    return { ok: true, revokedSessions: revoked };
  });

  app.post('/api/auth/logout', async (request, reply) => {
    destroySession(request, reply);
    return reply.code(204).send();
  });

  // OIDC step 1: stash PKCE/state in a short-lived signed cookie and redirect to the provider.
  app.get('/api/auth/oidc/start', async (_request, reply) => {
    const fail = (message: string) => reply.redirect(`/login?oidcError=${encodeURIComponent(message)}`);
    if (userCount() === 0) return fail('Complete first-run setup first');
    try {
      const config = await getOidcConfiguration();
      const codeVerifier = oidc.randomPKCECodeVerifier();
      const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);
      const state = oidc.randomState();
      const nonce = oidc.randomNonce();
      const authUrl = oidc.buildAuthorizationUrl(config, {
        redirect_uri: oidcRedirectUri(),
        scope: 'openid profile email',
        state,
        nonce,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
      });
      reply.setCookie('marquee_oidc', JSON.stringify({ state, nonce, codeVerifier }), {
        path: '/api/auth/oidc',
        httpOnly: true,
        sameSite: 'lax',
        signed: true,
        maxAge: 600,
      });
      return reply.redirect(authUrl.href);
    } catch (err) {
      return fail(err instanceof Error ? err.message : 'OIDC sign-in failed');
    }
  });

  // OIDC step 2: the provider redirects back here with a code; exchange and sign in.
  app.get('/api/auth/oidc/callback', async (request, reply) => {
    const fail = (message: string) => reply.redirect(`/login?oidcError=${encodeURIComponent(message)}`);
    try {
      const raw = request.cookies['marquee_oidc'];
      const unsigned = raw ? request.unsignCookie(raw) : null;
      reply.clearCookie('marquee_oidc', { path: '/api/auth/oidc' });
      if (!unsigned?.valid || !unsigned.value) return fail('Sign-in session expired — try again');
      const { state, nonce, codeVerifier } = JSON.parse(unsigned.value) as {
        state: string;
        nonce: string;
        codeVerifier: string;
      };

      const config = await getOidcConfiguration();
      const currentUrl = new URL(request.raw.url!, oidcRedirectUri());
      const tokens = await oidc.authorizationCodeGrant(config, currentUrl, {
        pkceCodeVerifier: codeVerifier,
        expectedState: state,
        expectedNonce: nonce,
      });
      const claims = tokens.claims();
      if (!claims?.sub) return fail('The identity provider returned no subject');

      let user = db.select().from(users).where(eq(users.oidcSub, claims.sub)).get();
      if (!user) {
        const email = typeof claims.email === 'string' ? claims.email : null;
        const preferred =
          (typeof claims.preferred_username === 'string' && claims.preferred_username) ||
          (typeof claims.name === 'string' && claims.name) ||
          email?.split('@')[0] ||
          `user-${claims.sub.slice(0, 8)}`;
        user = db
          .insert(users)
          .values({ username: uniqueUsername(preferred), passwordHash: null, oidcSub: claims.sub })
          .returning()
          .get();
      }
      await createSession(reply, user.id);
      return reply.redirect('/');
    } catch (err) {
      return fail(err instanceof Error ? err.message : 'OIDC sign-in failed');
    }
  });

  // Username/password sign-in against the configured Jellyfin or Emby server.
  for (const kind of ['jellyfin', 'emby'] as const) {
    app.post(`/api/auth/${kind}`, { config: AUTH_RATE }, async (request, reply) => {
      if (userCount() === 0) return reply.code(400).send({ error: 'Complete first-run setup first' });
      const parsed = z.object({ username: z.string().min(1), password: z.string() }).safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'Invalid request' });
      const label = kind === 'jellyfin' ? 'Jellyfin' : 'Emby';
      if (!getJfConfig(kind)) return reply.code(503).send({ error: `${label} sign-in is not enabled on this server` });
      // This is a password check against the media server too, so it backs off like local sign-in.
      if (throttled(kind, parsed.data.username, reply)) return reply;

      let account;
      try {
        account = await authenticateJf(kind, parsed.data.username, parsed.data.password);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Sign-in failed';
        if (message === 'INVALID_CREDENTIALS') {
          recordFailure(kind, parsed.data.username);
          return reply.code(401).send({ error: 'Invalid username or password' });
        }
        return reply.code(502).send({ error: message });
      }
      recordSuccess(kind, parsed.data.username);

      const idColumn = kind === 'jellyfin' ? users.jellyfinId : users.embyId;
      let user = db.select().from(users).where(eq(idColumn, account.id)).get();
      if (!user) {
        // Connecting a Jellyfin/Emby server is also how library sync is set up,
        // so creating accounts here unasked would let everyone on that server
        // in. A new account is registration, and follows its setting.
        if (!registrationOpen()) {
          logger.warn({ provider: kind, account: account.name }, 'refused new account from media-server sign-in: registration closed');
          return reply
            .code(403)
            .send({ error: `This server doesn’t create accounts from ${label} sign-ins — ask your admin for an account` });
        }
        user = db
          .insert(users)
          .values({
            username: uniqueUsername(account.name),
            passwordHash: null,
            ...(kind === 'jellyfin' ? { jellyfinId: account.id } : { embyId: account.id }),
          })
          .returning()
          .get();
      }
      await createSession(reply, user.id);
      return { user: { id: user.id, username: user.username, isAdmin: user.isAdmin } };
    });
  }

  // "Sign in with Plex" step 1: create a PIN and hand back the approval URL.
  // The PIN is bound to this browser with a short-lived signed cookie, so only
  // it can finish the sign-in (see step 2).
  app.post('/api/auth/plex/start', { config: AUTH_RATE }, async (request, reply) => {
    if (userCount() === 0) return reply.code(400).send({ error: 'Complete first-run setup before signing in with Plex' });
    try {
      const pin = await createLoginPin();
      const origin = getAppUrl() ?? `${request.protocol}://${request.headers.host}`;
      reply.setCookie(PLEX_PIN_COOKIE, String(pin.id), {
        path: '/api/auth/plex',
        httpOnly: true,
        sameSite: 'lax',
        signed: true,
        secure: request.protocol === 'https',
        maxAge: PLEX_PIN_COOKIE_MAX_AGE,
      });
      // The code is shown beside the Plex button so the person approving can
      // match it against plex.tv's: a PIN flow can't otherwise tell an approval
      // they meant from one someone else's link talked them into.
      return { pinId: pin.id, code: pin.code, authUrl: buildAuthUrl(pin.code, `${origin}/login?plexDone=1`) };
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : 'Could not reach plex.tv' });
    }
  });

  // Step 2: the client polls this (every 3s) until the user approves the PIN in the Plex tab.
  app.post('/api/auth/plex/complete', { config: PLEX_POLL_RATE }, async (request, reply) => {
    const parsed = z.object({ pinId: z.number().int() }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid request' });

    // Only the browser that started this sign-in may finish it. Without this,
    // anyone who guessed another person's PIN id could collect their session.
    const raw = request.cookies[PLEX_PIN_COOKIE];
    const unsigned = raw ? request.unsignCookie(raw) : null;
    if (!unsigned?.valid || unsigned.value !== String(parsed.data.pinId)) {
      return reply.code(403).send({ error: 'This Plex sign-in has expired or was started elsewhere — try again' });
    }

    let token: string | null;
    try {
      token = await checkLoginPin(parsed.data.pinId);
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : 'Could not reach plex.tv' });
    }
    if (!token) return { pending: true };
    // The PIN is spent once plex.tv hands over a token, whatever happens next.
    reply.clearCookie(PLEX_PIN_COOKIE, { path: '/api/auth/plex' });

    const cfg = getPlexConfig();
    if (!cfg) return reply.code(503).send({ error: 'Plex is not configured on this server yet — ask your admin' });

    let account;
    try {
      account = await getPlexAccount(token);
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : 'Could not reach plex.tv' });
    }
    let allowed;
    try {
      allowed = (await getServerAccessToken(cfg, token)) !== null;
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : 'Could not reach plex.tv' });
    }
    if (!allowed) {
      return reply.code(403).send({ error: 'Your Plex account does not have access to this Plex server' });
    }

    const user = upsertPlexUser(account, token);
    await createSession(reply, user.id);
    return { user: { id: user.id, username: user.username, isAdmin: user.isAdmin } };
  });

}

// Find-or-create the Marquee account for a plex.tv identity (regular or managed).
function upsertPlexUser(account: { id: number; username: string }, token: string): typeof users.$inferSelect {
  const plexId = String(account.id);
  const storedToken = encryptSecret(token);
  const existing = db.select().from(users).where(eq(users.plexId, plexId)).get();
  if (existing) {
    db.update(users).set({ plexToken: storedToken }).where(eq(users.id, existing.id)).run();
    logger.info({ userId: existing.id }, 'plex sign-in');
    return existing;
  }
  // Plex usernames may collide with existing local accounts — pick a free variant.
  const username = uniqueUsername(account.username);
  const created = db
    .insert(users)
    .values({ username, passwordHash: null, plexId, plexToken: storedToken })
    .returning()
    .get();
  logger.info({ userId: created.id, username }, 'new user created via plex sign-in');
  return created;
}
