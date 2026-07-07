import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { eq, sql } from 'drizzle-orm';
import * as oidc from 'openid-client';
import { z } from 'zod';
import { getOidcConfiguration, getOidcSettings, oidcRedirectUri } from './oidc.js';
import { config } from '../config.js';
import { encryptSecret } from '../crypto.js';
import { db } from '../db/index.js';
import { users } from '../db/schema.js';
import { authenticateJf, getJfConfig } from '../jellyfin/client.js';
import { logger } from '../logger.js';
import { buildAuthUrl, checkLoginPin, createLoginPin, getPlexAccount, hasServerAccess } from '../plex/plextv.js';
import { getPlexConfig, getSetting } from '../settings.js';
import { hashPassword, verifyPassword } from './passwords.js';
import { createSession, destroySession } from './plugin.js';

const credentialsSchema = z.object({
  username: z
    .string()
    .min(3, 'Username must be at least 3 characters')
    .max(32, 'Username must be at most 32 characters')
    .regex(/^[a-zA-Z0-9._-]+$/, 'Username may only contain letters, numbers, dots, dashes, and underscores'),
  password: z.string().min(8, 'Password must be at least 8 characters').max(200),
});

// Brute-force protection on credential endpoints.
const AUTH_RATE = { rateLimit: { max: 10, timeWindow: '1 minute' } };

// A throwaway hash so login spends the same scrypt time whether or not the
// username exists — closes the timing side channel that would otherwise let an
// attacker enumerate valid local accounts.
const DUMMY_PASSWORD_HASH = hashPassword(crypto.randomBytes(16).toString('hex'));

function userCount(): number {
  return db.select({ c: sql<number>`count(*)` }).from(users).get()!.c;
}

export async function authRoutes(app: FastifyInstance) {
  app.get('/api/auth/status', async (request) => {
    return {
      needsSetup: userCount() === 0,
      user: request.user,
      idleTimeoutMinutes: request.user
        ? request.user.isAdmin
          ? config.adminIdleMinutes
          : config.userIdleMinutes
        : null,
      authMethods: {
        plex: !!getPlexConfig(),
        jellyfin: !!getJfConfig('jellyfin'),
        emby: !!getJfConfig('emby'),
        oidc: !!getOidcSettings(),
        oidcLabel: getOidcSettings()?.label ?? null,
        allowRegistration: getSetting('auth.allowRegistration') !== 'false',
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
        passwordHash: hashPassword(parsed.data.password),
        isAdmin: true,
      })
      .returning({ id: users.id, username: users.username, isAdmin: users.isAdmin })
      .get();
    await createSession(reply, user.id);
    return reply.code(201).send({ user });
  });

  app.post('/api/auth/register', { config: AUTH_RATE }, async (request, reply) => {
    if (userCount() === 0) return reply.code(400).send({ error: 'Use setup to create the first admin account' });
    if (getSetting('auth.allowRegistration') === 'false') {
      return reply.code(403).send({ error: 'Registration is disabled on this server — ask your admin for an account' });
    }
    const parsed = credentialsSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid request' });
    const existing = db.select({ id: users.id }).from(users).where(eq(users.username, parsed.data.username)).get();
    if (existing) return reply.code(409).send({ error: 'That username is already taken' });
    const user = db
      .insert(users)
      .values({ username: parsed.data.username, passwordHash: hashPassword(parsed.data.password) })
      .returning({ id: users.id, username: users.username, isAdmin: users.isAdmin })
      .get();
    await createSession(reply, user.id);
    return reply.code(201).send({ user });
  });

  app.post('/api/auth/login', { config: AUTH_RATE }, async (request, reply) => {
    const parsed = z.object({ username: z.string(), password: z.string() }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid request' });
    const user = db.select().from(users).where(eq(users.username, parsed.data.username)).get();
    // Always verify against a hash (a dummy one when the account is missing or
    // has no local password) so response time doesn't reveal which usernames exist.
    const passwordOk = verifyPassword(parsed.data.password, user?.passwordHash ?? DUMMY_PASSWORD_HASH);
    if (!user?.passwordHash || !passwordOk) {
      logger.warn({ username: parsed.data.username, ip: request.ip }, 'failed login attempt');
      return reply.code(401).send({ error: 'Invalid username or password' });
    }
    await createSession(reply, user.id);
    return { user: { id: user.id, username: user.username, isAdmin: user.isAdmin } };
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
        let username = preferred;
        let suffix = 1;
        while (db.select({ id: users.id }).from(users).where(eq(users.username, username)).get()) {
          username = `${preferred}-${++suffix}`;
        }
        user = db.insert(users).values({ username, passwordHash: null, oidcSub: claims.sub }).returning().get();
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
      if (!getJfConfig(kind)) {
        return reply.code(503).send({ error: `${kind === 'jellyfin' ? 'Jellyfin' : 'Emby'} sign-in is not enabled on this server` });
      }

      let account;
      try {
        account = await authenticateJf(kind, parsed.data.username, parsed.data.password);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Sign-in failed';
        if (message === 'INVALID_CREDENTIALS') {
          return reply.code(401).send({ error: 'Invalid username or password' });
        }
        return reply.code(502).send({ error: message });
      }

      const idColumn = kind === 'jellyfin' ? users.jellyfinId : users.embyId;
      let user = db.select().from(users).where(eq(idColumn, account.id)).get();
      if (!user) {
        let username = account.name;
        let suffix = 1;
        while (db.select({ id: users.id }).from(users).where(eq(users.username, username)).get()) {
          username = `${account.name}-${++suffix}`;
        }
        user = db
          .insert(users)
          .values({
            username,
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
  app.post('/api/auth/plex/start', async (request, reply) => {
    if (userCount() === 0) return reply.code(400).send({ error: 'Complete first-run setup before signing in with Plex' });
    try {
      const pin = await createLoginPin();
      const origin = getSetting('app.url')?.replace(/\/+$/, '') ?? `${request.protocol}://${request.headers.host}`;
      return { pinId: pin.id, code: pin.code, authUrl: buildAuthUrl(pin.code, `${origin}/login?plexDone=1`) };
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : 'Could not reach plex.tv' });
    }
  });

  // Step 2: the client polls this until the user approves the PIN in the Plex tab.
  app.post('/api/auth/plex/complete', async (request, reply) => {
    const parsed = z.object({ pinId: z.number().int() }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid request' });

    let token: string | null;
    try {
      token = await checkLoginPin(parsed.data.pinId);
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : 'Could not reach plex.tv' });
    }
    if (!token) return { pending: true };

    const cfg = getPlexConfig();
    if (!cfg) return reply.code(503).send({ error: 'Plex is not configured on this server yet — ask your admin' });

    let account;
    try {
      account = await getPlexAccount(token);
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : 'Could not reach plex.tv' });
    }
    if (!(await hasServerAccess(cfg.url, token))) {
      return reply.code(403).send({ error: 'Your Plex account does not have access to this Plex server' });
    }

    const user = upsertPlexUser(account, token);
    await createSession(reply, user.id);
    return { user: { id: user.id, username: user.username, isAdmin: user.isAdmin } };
  });

}

// Find-or-create the Marquee account for a plex.tv identity (regular or managed).
function upsertPlexUser(
  account: { id: number; username: string; thumb: string | null },
  token: string,
): typeof users.$inferSelect {
  const plexId = String(account.id);
  const storedToken = encryptSecret(token);
  const existing = db.select().from(users).where(eq(users.plexId, plexId)).get();
  if (existing) {
    db.update(users).set({ plexToken: storedToken, avatar: account.thumb }).where(eq(users.id, existing.id)).run();
    logger.info({ userId: existing.id }, 'plex sign-in');
    return existing;
  }
  // Plex usernames may collide with existing local accounts — pick a free variant.
  let username = account.username;
  let suffix = 1;
  while (db.select({ id: users.id }).from(users).where(eq(users.username, username)).get()) {
    username = `${account.username}-${++suffix}`;
  }
  const created = db
    .insert(users)
    .values({ username, passwordHash: null, plexId, plexToken: storedToken, avatar: account.thumb })
    .returning()
    .get();
  logger.info({ userId: created.id, username }, 'new user created via plex sign-in');
  return created;
}
