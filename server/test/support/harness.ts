import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { startMocks } from './mocks.js';

// One Marquee per test file (node:test runs each file in its own process),
// with its own throwaway data folder and mock outside services. The server
// reads its configuration as its modules load, so the environment is set
// before they're imported.
export async function startMarquee() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'marquee-test-'));
  const mocks = await startMocks();
  Object.assign(process.env, {
    DATA_DIR: dataDir,
    LOG_LEVEL: process.env.LOG_LEVEL ?? 'silent',
    TMDB_API_URL: mocks.urls.tmdb,
    PLEX_TV_URL: mocks.urls.plexTv,
    PLEX_DISCOVER_URL: mocks.urls.discover,
    TRAKT_API_URL: mocks.urls.trakt,
    UPDATE_CHECK_URL: mocks.urls.releases,
  });
  const { db, closeDatabase, runMigrations } = await import('../../src/db/index.js');
  runMigrations();
  const { buildApp } = await import('../../src/app.js');
  const app = await buildApp();
  await app.ready();

  return {
    app,
    db,
    mocks,
    // A browser-like client with its own cookie jar.
    client: () => client(app),
    async stop() {
      await app.close();
      closeDatabase();
      await mocks.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

export type Marquee = Awaited<ReturnType<typeof startMarquee>>;

export interface Reply<T> {
  status: number;
  data: T;
  headers: Record<string, string | string[] | number | undefined>;
  body: Buffer;
}

function client(app: Pick<FastifyInstance, 'inject'>) {
  const cookies = new Map<string, string>();
  return async function call<T = any>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<Reply<T>> {
    const res = await app.inject({
      method,
      url,
      ...(body !== undefined ? { payload: body as object } : {}),
      headers: { cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; '), ...headers },
    });
    for (const c of res.cookies as { name: string; value: string; maxAge?: number; expires?: Date }[]) {
      const cleared = c.value === '' || c.maxAge === 0 || (c.expires !== undefined && c.expires.getTime() < Date.now());
      if (cleared) cookies.delete(c.name);
      else cookies.set(c.name, c.value);
    }
    const isJson = String(res.headers['content-type'] ?? '').includes('json');
    return { status: res.statusCode, data: (isJson ? res.json() : undefined) as T, headers: res.headers, body: res.rawPayload };
  };
}

export type Client = ReturnType<typeof client>;

// The usual starting point: an admin, Plex and Jellyfin connected, the library synced.
export async function withLibrary(m: Marquee) {
  const admin = m.client();
  let r = await admin('POST', '/api/auth/setup', { username: 'Admin', password: 'password123' });
  if (r.status !== 201) throw new Error(`setup failed: ${r.status}`);
  r = await admin('PUT', '/api/admin/settings', {
    plexUrl: m.mocks.urls.plex,
    plexToken: 'owner-token',
    jellyfinUrl: m.mocks.urls.jellyfin,
    jellyfinApiKey: 'jf-key',
    appUrl: 'http://marquee.test/',
  });
  if (r.status !== 200) throw new Error(`settings failed: ${r.status}`);
  r = await admin('POST', '/api/admin/sync', {});
  if (r.status !== 200) throw new Error(`sync failed: ${JSON.stringify(r.data)}`);
  const media = (await admin<{ id: number; title: string }[]>('GET', '/api/media?q=')).data;
  const byTitle = Object.fromEntries(media.map((item) => [item.title, item.id])) as Record<string, number>;
  return { admin, byTitle };
}

// A second, regular member.
export async function signUp(m: Marquee, username: string) {
  const member = m.client();
  const r = await member('POST', '/api/auth/register', { username, password: 'password123' });
  if (r.status !== 201) throw new Error(`register failed: ${r.status}`);
  const me = (await member<{ user: { id: number } }>('GET', '/api/auth/status')).data.user;
  return { member, id: me.id };
}
