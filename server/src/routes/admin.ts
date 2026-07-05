import type { FastifyInstance } from 'fastify';
import { desc, eq, sql, type SQL } from 'drizzle-orm';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { z } from 'zod';
import { db } from '../db/index.js';
import { issueReports, lists, media, pollOptions, polls, users, votes } from '../db/schema.js';
import { requireAdmin } from '../auth/plugin.js';
import { clearOidcCache, getOidcConfiguration, getOidcSettings } from '../auth/oidc.js';
import { startDiscordBot, testDiscord } from '../discord/bot.js';
import { testJf } from '../jellyfin/client.js';
import { getSections } from '../plex/client.js';
import { getSeerrConfig, testSeerr } from '../seerr/client.js';
import { getPlexConfig, getSetting, setSetting } from '../settings.js';
import { syncAllSources } from '../sources/index.js';
import { getScanState, startFranchiseScan } from '../tmdb/scan.js';

export async function adminRoutes(app: FastifyInstance) {
  app.get('/api/admin/stats', { preHandler: requireAdmin }, async () => {
    const count = (table: SQLiteTable, where?: SQL) =>
      db.select({ c: sql<number>`count(*)` }).from(table).where(where).get()!.c;

    const topChoices = db
      .select({ title: pollOptions.title, votes: sql<number>`count(${votes.id})` })
      .from(votes)
      .innerJoin(pollOptions, eq(votes.optionId, pollOptions.id))
      .groupBy(pollOptions.title)
      .orderBy(desc(sql`count(${votes.id})`))
      .limit(5)
      .all();

    const recentPolls = db
      .select({
        id: polls.id,
        title: polls.title,
        status: polls.status,
        shareToken: polls.shareToken,
        createdAt: polls.createdAt,
      })
      .from(polls)
      .orderBy(desc(polls.createdAt))
      .limit(5)
      .all();

    return {
      users: count(users),
      polls: count(polls),
      openPolls: count(polls, eq(polls.status, 'open')),
      votes: count(votes),
      media: count(media),
      lists: count(lists),
      openIssues: count(issueReports, eq(issueReports.status, 'open')),
      topChoices,
      recentPolls,
    };
  });

  const settingsPayload = () => ({
    plexUrl: getSetting('plex.url'),
    plexTokenSet: !!getSetting('plex.token'),
    jellyfinUrl: getSetting('jellyfin.url'),
    jellyfinKeySet: !!getSetting('jellyfin.apiKey'),
    embyUrl: getSetting('emby.url'),
    embyKeySet: !!getSetting('emby.apiKey'),
    traktClientId: getSetting('trakt.clientId'),
    traktSecretSet: !!getSetting('trakt.clientSecret'),
    tmdbKeySet: !!getSetting('tmdb.apiKey'),
    discordTokenSet: !!getSetting('discord.botToken'),
    discordChannelId: getSetting('discord.channelId'),
    appUrl: getSetting('app.url'),
    oidcIssuer: getSetting('oidc.issuer'),
    oidcClientId: getSetting('oidc.clientId'),
    oidcSecretSet: !!getSetting('oidc.clientSecret'),
    oidcLabel: getSetting('oidc.label'),
    oidcRedirectUri: getSetting('app.url')
      ? `${getSetting('app.url')!.replace(/\/+$/, '')}/api/auth/oidc/callback`
      : null,
    seerrUrl: getSetting('seerr.url'),
    seerrKind: getSetting('seerr.kind') === 'ombi' ? ('ombi' as const) : ('overseerr' as const),
    seerrKeySet: !!getSetting('seerr.apiKey'),
    allowRegistration: getSetting('auth.allowRegistration') !== 'false',
  });

  app.get('/api/admin/settings', { preHandler: requireAdmin }, async () => settingsPayload());

  app.put('/api/admin/settings', { preHandler: requireAdmin }, async (request, reply) => {
    const parsed = z
      .object({
        plexUrl: z.string().url('Enter a valid URL, e.g. http://192.168.1.10:32400').optional(),
        plexToken: z.string().optional(),
        jellyfinUrl: z.string().url('Enter a valid URL, e.g. http://192.168.1.10:8096').optional(),
        jellyfinApiKey: z.string().optional(),
        embyUrl: z.string().url('Enter a valid URL, e.g. http://192.168.1.10:8096').optional(),
        embyApiKey: z.string().optional(),
        traktClientId: z.string().optional(),
        traktClientSecret: z.string().optional(),
        tmdbApiKey: z.string().optional(),
        discordBotToken: z.string().optional(),
        discordChannelId: z.string().optional(),
        appUrl: z.string().url('Enter a valid URL, e.g. https://marquee.example.com').optional(),
        oidcIssuer: z.string().url('Enter the issuer URL, e.g. https://auth.example.com/application/o/marquee/').optional(),
        oidcClientId: z.string().optional(),
        oidcClientSecret: z.string().optional(),
        oidcLabel: z.string().max(40).optional(),
        seerrUrl: z.string().url('Enter a valid request-service URL').optional(),
        seerrApiKey: z.string().optional(),
        seerrKind: z.enum(['overseerr', 'ombi']).optional(),
        allowRegistration: z.boolean().optional(),
      })
      .safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid request' });
    if (parsed.data.plexUrl) setSetting('plex.url', parsed.data.plexUrl);
    if (parsed.data.plexToken) setSetting('plex.token', parsed.data.plexToken);
    if (parsed.data.jellyfinUrl) setSetting('jellyfin.url', parsed.data.jellyfinUrl);
    if (parsed.data.jellyfinApiKey) setSetting('jellyfin.apiKey', parsed.data.jellyfinApiKey.trim());
    if (parsed.data.embyUrl) setSetting('emby.url', parsed.data.embyUrl);
    if (parsed.data.embyApiKey) setSetting('emby.apiKey', parsed.data.embyApiKey.trim());
    if (parsed.data.traktClientId !== undefined) setSetting('trakt.clientId', parsed.data.traktClientId.trim());
    if (parsed.data.traktClientSecret) setSetting('trakt.clientSecret', parsed.data.traktClientSecret.trim());
    if (parsed.data.tmdbApiKey) setSetting('tmdb.apiKey', parsed.data.tmdbApiKey.trim());
    if (parsed.data.discordChannelId !== undefined) setSetting('discord.channelId', parsed.data.discordChannelId.trim());
    if (parsed.data.appUrl) setSetting('app.url', parsed.data.appUrl);
    if (parsed.data.discordBotToken) {
      setSetting('discord.botToken', parsed.data.discordBotToken.trim());
      await startDiscordBot();
    }
    if (parsed.data.oidcIssuer) setSetting('oidc.issuer', parsed.data.oidcIssuer.trim());
    if (parsed.data.oidcClientId !== undefined) setSetting('oidc.clientId', parsed.data.oidcClientId.trim());
    if (parsed.data.oidcClientSecret) setSetting('oidc.clientSecret', parsed.data.oidcClientSecret.trim());
    if (parsed.data.oidcLabel !== undefined) setSetting('oidc.label', parsed.data.oidcLabel.trim());
    if (parsed.data.oidcIssuer || parsed.data.oidcClientId !== undefined || parsed.data.oidcClientSecret) {
      clearOidcCache();
    }
    if (parsed.data.seerrUrl) setSetting('seerr.url', parsed.data.seerrUrl);
    if (parsed.data.seerrApiKey) setSetting('seerr.apiKey', parsed.data.seerrApiKey.trim());
    if (parsed.data.seerrKind) setSetting('seerr.kind', parsed.data.seerrKind);
    if (parsed.data.allowRegistration !== undefined) {
      setSetting('auth.allowRegistration', String(parsed.data.allowRegistration));
    }
    return settingsPayload();
  });

  // TMDb franchise scan: kick off / poll progress.
  app.post('/api/admin/tmdb/scan', { preHandler: requireAdmin }, async (_request, reply) => {
    try {
      return startFranchiseScan();
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : 'Could not start scan' });
    }
  });

  app.get('/api/admin/tmdb/scan', { preHandler: requireAdmin }, async () => getScanState());

  app.post('/api/admin/oidc/test', { preHandler: requireAdmin }, async (_request, reply) => {
    if (!getOidcSettings()) return reply.code(400).send({ error: 'Set the issuer, client ID, and client secret first' });
    try {
      const config = await getOidcConfiguration();
      const meta = config.serverMetadata();
      return { ok: true, issuer: meta.issuer, authorizationEndpoint: meta.authorization_endpoint ?? null };
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : 'Discovery failed — check the issuer URL' });
    }
  });

  app.post('/api/admin/discord/test', { preHandler: requireAdmin }, async (_request, reply) => {
    try {
      return { ok: true, ...(await testDiscord()) };
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : 'Discord test failed' });
    }
  });

  app.post('/api/admin/seerr/test', { preHandler: requireAdmin }, async (_request, reply) => {
    const cfg = getSeerrConfig();
    if (!cfg) return reply.code(400).send({ error: 'Set the request-service URL and API key first' });
    try {
      await testSeerr(cfg);
      return { ok: true };
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : 'Could not reach the request service' });
    }
  });

  app.post('/api/admin/plex/test', { preHandler: requireAdmin }, async (_request, reply) => {
    const cfg = getPlexConfig();
    if (!cfg) return reply.code(400).send({ error: 'Set the Plex URL and token first' });
    try {
      const sections = await getSections(cfg.url, cfg.token);
      return { ok: true, sections: sections.map((s) => ({ title: s.title, type: s.type })) };
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : 'Could not reach Plex' });
    }
  });

  app.post('/api/admin/jellyfin/test', { preHandler: requireAdmin }, async (_request, reply) => {
    try {
      const info = await testJf('jellyfin');
      return { ok: true, serverName: info.serverName, version: info.version };
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : 'Could not reach Jellyfin' });
    }
  });

  app.post('/api/admin/emby/test', { preHandler: requireAdmin }, async (_request, reply) => {
    try {
      const info = await testJf('emby');
      return { ok: true, serverName: info.serverName, version: info.version };
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : 'Could not reach Emby' });
    }
  });

  // Sync every configured media server (Plex / Jellyfin / Emby).
  app.post('/api/admin/sync', { preHandler: requireAdmin }, async (_request, reply) => {
    try {
      return await syncAllSources();
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : 'Sync failed' });
    }
  });

  app.get('/api/admin/issues', { preHandler: requireAdmin }, async () => {
    return db
      .select({
        id: issueReports.id,
        username: users.username,
        subject: issueReports.subject,
        body: issueReports.body,
        status: issueReports.status,
        createdAt: issueReports.createdAt,
      })
      .from(issueReports)
      .leftJoin(users, eq(issueReports.userId, users.id))
      .orderBy(desc(issueReports.createdAt))
      .all();
  });

  app.patch('/api/admin/issues/:id', { preHandler: requireAdmin }, async (request, reply) => {
    const parsed = z.object({ status: z.enum(['open', 'resolved']) }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid request' });
    const id = Number((request.params as { id: string }).id);
    db.update(issueReports).set({ status: parsed.data.status }).where(eq(issueReports.id, id)).run();
    return { ok: true };
  });
}
