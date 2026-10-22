import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { CollectionProgress, TraktStatus, WatchWithWatchlistResult } from '@marquee/shared';
import { startMarquee, withLibrary, type Client, type Marquee } from './support/harness.js';

let m: Marquee;
let admin: Client;
let pal: Client;
let palId: number;

// Stored tokens are encrypted, but plaintext ones (from before encryption) still read back fine.
function setUser(username: string, fields: Record<string, string>) {
  const sets = Object.keys(fields).map((k) => `${k} = @${k}`).join(', ');
  m.db.$client.prepare(`update users set ${sets} where lower(username) = lower(@username)`).run({ ...fields, username });
}

before(async () => {
  m = await startMarquee();
  ({ admin } = await withLibrary(m));
});
after(() => m.stop());

test('Plex sign-in admits accounts the server is shared with', async () => {
  pal = m.client();
  let r = await pal<{ pinId: number; authUrl: string }>('POST', '/api/auth/plex/start', {});
  assert.equal(r.status, 200);
  assert.equal(r.data.pinId, 77);
  r = await pal('POST', '/api/auth/plex/complete', { pinId: 77 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const status = await pal<{ user: { id: number; username: string } }>('GET', '/api/auth/status');
  assert.equal(status.data.user.username, 'pal');
  palId = status.data.user.id;
});

test('…and turns away accounts it isn’t shared with', async () => {
  m.mocks.data.pinToken = 'stranger-token';
  const stranger = m.client();
  await stranger('POST', '/api/auth/plex/start', {});
  const r = await stranger('POST', '/api/auth/plex/complete', { pinId: 77 });
  assert.equal(r.status, 403);
  assert.equal((await stranger('GET', '/api/auth/status')).data.user, null);
});

test('collections count a Plex user’s own watch history', async () => {
  // pal has seen both Alien films; the sync account only the first.
  let r = await pal<CollectionProgress[]>('GET', '/api/collections');
  assert.equal(r.data[0]!.watchedCount, 2);
  const detail = await pal<{ items: { watchedByMe: boolean }[] }>('GET', `/api/collections/${r.data[0]!.id}`);
  assert.ok(detail.data.items.every((i) => i.watchedByMe));
  r = await admin<CollectionProgress[]>('GET', '/api/collections');
  assert.equal(r.data[0]!.watchedCount, 1);
});

test('watchlist mode reads past the first page of a watchlist', async () => {
  setUser('Admin', { plex_token: 'owner-plex-token' });
  const r = await admin<WatchWithWatchlistResult>('POST', '/api/watchwith/watchlist', { partnerId: palId });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.title, 'Item 120');
  assert.equal(r.data.poolSize, 1);
  const pages = m.mocks.requests.discover.filter((q) => q.startsWith('owner-plex-token'));
  assert.deepEqual(pages, ['owner-plex-token:0:100', 'owner-plex-token:100:100']);
});

test('a Trakt account with nothing imported yet doesn’t hide Plex history', async () => {
  setUser('pal', { trakt_token: 'not-yet-imported' });
  const r = await pal<CollectionProgress[]>('GET', '/api/collections');
  assert.equal(r.data[0]!.watchedCount, 2, 'still pal’s own Plex history');
});

test('a watchlist pick only matches a library title of the same type', async () => {
  // TMDb 95396 is Severance (a show); here it's a movie on both watchlists.
  const both = [{ title: 'Not Severance', type: 'movie', Guid: [{ id: 'tmdb://95396' }] }];
  const saved = { ...m.mocks.data.watchlists };
  m.mocks.data.watchlists['owner-plex-token'] = both;
  m.mocks.data.watchlists['shared-plex-token'] = both;
  const r = await admin<WatchWithWatchlistResult>('POST', '/api/watchwith/watchlist', { partnerId: palId });
  assert.equal(r.data.media, null);
  assert.equal(r.data.tmdbId, 95396, 'offered as a request instead');
  Object.assign(m.mocks.data.watchlists, saved);
});

test('Trakt history is matched again after each library sync', async () => {
  await admin('PUT', '/api/admin/settings', { traktClientId: 'trakt-id', traktClientSecret: 'trakt-secret' });
  setUser('pal', { trakt_token: 'trakt-token' });
  const r = await pal<{ watchedCount: number }>('POST', '/api/trakt/refresh', {});
  assert.equal(r.data.watchedCount, 2, 'Aliens and Severance; the third film isn’t in the library');
  assert.ok(m.mocks.requests.trakt.includes('/sync/watched/shows?extended=noseasons'));

  m.mocks.data.plexMovies.push({ ratingKey: '105', title: 'Newcomer', year: 2026, type: 'movie', Guid: [{ id: 'imdb://tt7777777' }] });
  await admin('POST', '/api/admin/sync', {});
  let count = 0;
  for (let i = 0; i < 40 && count !== 3; i++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    count = (await pal<TraktStatus>('GET', '/api/trakt/status')).data.watchedCount;
  }
  assert.equal(count, 3);

  const collections = await pal<CollectionProgress[]>('GET', '/api/collections');
  assert.equal(collections.data[0]!.watchedCount, 1, 'Trakt comes first once connected');
});

test('Overseerr gets its key as X-Api-Key', async () => {
  await admin('PUT', '/api/admin/settings', { seerrUrl: m.mocks.urls.overseerr, seerrApiKey: 'seerr-key', seerrKind: 'overseerr' });
  assert.equal((await admin('POST', '/api/admin/seerr/test', {})).status, 200);
});

test('Ombi gets its key as ApiKey, so a wrong key fails the test', async () => {
  await admin('PUT', '/api/admin/settings', { seerrUrl: m.mocks.urls.ombi, seerrApiKey: 'wrong', seerrKind: 'ombi' });
  let r = await admin<{ error: string }>('POST', '/api/admin/seerr/test', {});
  assert.equal(r.status, 502);
  assert.match(r.data.error, /401/);

  await admin('PUT', '/api/admin/settings', { seerrApiKey: 'ombi-key' });
  assert.equal((await admin('POST', '/api/admin/seerr/test', {})).status, 200);
  r = await admin('POST', '/api/requests', { tmdbId: 8077 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(m.mocks.requests.ombi.at(-1), { path: '/api/v1/Request/movie', apiKey: 'ombi-key', xApiKey: null });
  assert.equal((await pal('POST', '/api/requests', { tmdbId: 8077 })).status, 403, 'Ombi requests stay admin-only');
});
