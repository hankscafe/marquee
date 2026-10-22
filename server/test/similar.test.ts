import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { RandomPick } from '@marquee/shared';
import { startMarquee, withLibrary, type Client, type Marquee } from './support/harness.js';

// "Like what I've been watching". pal signs in with Plex and has watched Alien
// and, more recently, Aliens. For Aliens, the mock suggests Arrival, Alien, a
// TMDb *show* id (Severance's) and something not in the library; for Alien, Dune.

let m: Marquee;
let admin: Client;
let pal: Client;

const spin = (who: Client, filters: object) => who<RandomPick>('POST', '/api/media/random', { similarToRecent: true, ...filters });

async function titlesFrom(who: Client, filters: object, draws = 25) {
  const seen = new Set<string>();
  for (let i = 0; i < draws; i++) seen.add((await spin(who, filters)).data.title);
  return [...seen].sort();
}

before(async () => {
  m = await startMarquee();
  ({ admin } = await withLibrary(m));
  pal = m.client();
  await pal('POST', '/api/auth/plex/start', {});
  await pal('POST', '/api/auth/plex/complete', { pinId: 77 });
});
after(() => m.stop());

test('without TMDb or a request service the spin still happens, and says why', async () => {
  const r = await spin(pal, {});
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.similarToRecent, { status: 'not-configured', seedCount: 0, matchCount: 0 });
  await admin('PUT', '/api/admin/settings', { seerrUrl: m.mocks.urls.ombi, seerrApiKey: 'ombi-key', seerrKind: 'ombi' });
  assert.equal((await spin(pal, {})).data.similarToRecent?.status, 'unsupported');
});

test('Overseerr suggestions narrow the draw, matched by TMDb id and type', async () => {
  await admin('PUT', '/api/admin/settings', { seerrUrl: m.mocks.urls.overseerr, seerrApiKey: 'seerr-key', seerrKind: 'overseerr' });
  const r = await spin(pal, { recentSeedCount: 1 });
  assert.deepEqual(r.data.similarToRecent, { status: 'applied', seedCount: 1, matchCount: 2 });
  assert.deepEqual(await titlesFrom(pal, { recentSeedCount: 1 }), ['Alien', 'Arrival'], 'not Severance: that id is a show');
  assert.ok(m.mocks.requests.overseerr.includes('/api/v1/movie/679/recommendations'));
  assert.ok(m.mocks.requests.overseerr.includes('/api/v1/movie/679/similar'));
});

test('it composes with the other filters and runs last', async () => {
  // Two seeds add Dune; leaving out what pal has seen leaves Arrival and Dune.
  assert.deepEqual(await titlesFrom(pal, { recentSeedCount: 2 }), ['Alien', 'Arrival', 'Dune']);
  const r = await spin(pal, { recentSeedCount: 2, unwatchedOnly: true });
  assert.deepEqual(r.data.similarToRecent, { status: 'applied', seedCount: 2, matchCount: 2 });
  assert.deepEqual(await titlesFrom(pal, { recentSeedCount: 2, unwatchedOnly: true }), ['Arrival', 'Dune']);
  assert.equal((await spin(pal, { recentSeedCount: 1, type: 'show' })).data.similarToRecent?.status, 'no-matches');
});

test('suggestions are cached, and a TMDb key takes over from the request service', async () => {
  const before = m.mocks.requests.overseerr.length;
  await spin(pal, { recentSeedCount: 2 });
  assert.equal(m.mocks.requests.overseerr.length, before, 'cached');

  await admin('PUT', '/api/admin/settings', { tmdbApiKey: 'tmdb-key' });
  m.mocks.data.seerrDown = true; // proves the request service isn't asked any more
  const r = await spin(pal, { recentSeedCount: 1 });
  assert.deepEqual(r.data.similarToRecent, { status: 'applied', seedCount: 1, matchCount: 2 });
  assert.ok(m.mocks.requests.tmdb.includes('/3/movie/679/recommendations'));
  m.mocks.data.seerrDown = false;
});

test('when every lookup fails, the spin goes ahead without it', async () => {
  const { setSetting } = await import('../src/settings.js');
  const { clearSuggestionCache } = await import('../src/randomizer/similar.js');
  setSetting('tmdb.apiKey', ''); // back to the request service…
  clearSuggestionCache();
  m.mocks.data.seerrDown = true; // …which is down
  const r = await spin(pal, { recentSeedCount: 1 });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.similarToRecent, { status: 'unavailable', seedCount: 1, matchCount: 0 });
  m.mocks.data.seerrDown = false;
});

test('people without dated history get an ordinary spin', async () => {
  // The admin has no Plex account or Trakt: only the sync account's undated flags.
  const r = await spin(admin, {});
  assert.equal(r.status, 200);
  assert.equal(r.data.similarToRecent?.status, 'no-history');
  const plain = await admin<RandomPick>('POST', '/api/media/random', {});
  assert.ok(!('similarToRecent' in plain.data), 'only reported when asked for');
});

test('Trakt history is dated, and seeds from the most recent watch first', async () => {
  await admin('PUT', '/api/admin/settings', { traktClientId: 'trakt-id', traktClientSecret: 'trakt-secret' });
  m.db.$client.prepare("update users set trakt_token = 'trakt-token' where username = 'pal'").run();
  await pal('POST', '/api/trakt/refresh', {});
  const rows = m.db.$client
    .prepare("select m.title, w.watched_at as at from user_watched w join media m on m.id = w.media_id join users u on u.id = w.user_id where u.username = 'pal' order by w.watched_at desc")
    .all() as { title: string; at: number }[];
  assert.deepEqual(rows.map((r) => r.title), ['Severance', 'Aliens']);
  assert.equal(rows[1]!.at, Date.parse('2026-10-01T20:00:00.000Z') / 1000);

  // Severance is the latest, but the mock suggests nothing for it; with two seeds Aliens counts too.
  assert.equal((await spin(pal, { recentSeedCount: 1 })).data.similarToRecent?.status, 'no-matches');
  assert.deepEqual((await spin(pal, { recentSeedCount: 2 })).data.similarToRecent, { status: 'applied', seedCount: 2, matchCount: 2 });
});
