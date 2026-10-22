import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { CollectionProgress, FranchisesResponse, MediaItem, NowPlayingResponse, TmdbScanStatus } from '@marquee/shared';
import { BIG, PNG } from './support/mocks.js';
import { signUp, startMarquee, withLibrary, type Client, type Marquee } from './support/harness.js';

let m: Marquee;
let admin: Client;
let byTitle: Record<string, number>;
let media: Record<string, MediaItem>;

before(async () => {
  m = await startMarquee();
  ({ admin, byTitle } = await withLibrary(m));
  const list = (await admin<MediaItem[]>('GET', '/api/media?q=')).data;
  media = Object.fromEntries(list.map((item) => [item.title, item]));
});
after(() => m.stop());

test('titles on several servers are shown once', () => {
  // 6 from Plex + 2 from Jellyfin, with Alien on both.
  assert.deepEqual(Object.keys(media).sort(), ['Alien', 'Aliens', 'Andor', 'Arrival', 'Dune', 'Heat', 'Severance']);
  assert.equal(media.Alien!.source, 'plex', 'Plex copies win');
  assert.ok(!('copyIds' in media.Alien!));
});

test('watch links point into each server’s own app', () => {
  assert.match(media.Alien!.watchUrl!, /^https:\/\/app\.plex\.tv\/desktop#!\/server\/mock-machine\/details\?key=/);
  assert.equal(media.Dune!.watchUrl, `${m.mocks.urls.jellyfin}web/index.html#!/details?id=jf-dune&serverId=jf-server`);
});

test('Plex’s watched rule: any view of a movie, every episode of a show', () => {
  assert.equal(media.Alien!.watched, true);
  assert.equal(media.Aliens!.watched, false);
  assert.equal(media.Severance!.watched, true);
  assert.equal(media.Andor!.watched, false);
});

test('the randomizer honours its filters and returns the whole title', async () => {
  const draw = (filters: object) => admin<MediaItem>('POST', '/api/media/random', filters);
  assert.equal((await draw({ type: 'show' })).data.type, 'show');
  assert.equal((await draw({ genre: 'Crime' })).data.title, 'Heat');
  assert.equal((await draw({ genre: 'Nope' })).status, 404);

  const best = (await draw({ minRating: 8.45 })).data;
  assert.equal(best.title, 'Alien');
  assert.equal(best.rating, 8.5);
  assert.deepEqual(best.genres, ['Horror']);
  assert.equal(best.watched, true);
  assert.ok(!('copyIds' in best));

  const collection = (await admin<{ collections: { id: number }[] }>('GET', '/api/media/filters')).data.collections[0]!;
  assert.ok(['Alien', 'Aliens'].includes((await draw({ collectionId: collection.id })).data.title));

  const list = (await admin<{ id: number }>('POST', '/api/lists', { name: 'Faves' })).data;
  await admin('POST', `/api/lists/${list.id}/items`, { mediaId: byTitle.Arrival });
  assert.equal((await draw({ listId: list.id })).data.title, 'Arrival');

  // Watched on any copy rules a title out: Alien (Plex), Severance (every episode), Dune (Jellyfin).
  const seen = new Set<string>();
  for (let i = 0; i < 40; i++) seen.add((await draw({ unwatchedOnly: true })).data.title);
  assert.deepEqual([...seen].sort(), ['Aliens', 'Andor', 'Arrival', 'Heat']);
});

test('Watch With draws what neither person has seen, from people who allow it', async () => {
  const { member, id } = await signUp(m, 'member');
  let r = await admin<{ id: number; username: string }[]>('GET', '/api/watchwith/partners');
  assert.deepEqual(r.data.map((p) => p.username), ['member']);

  const show = await admin<{ pick: MediaItem }>('POST', '/api/watchwith/library', { partnerId: id, type: 'show' });
  assert.equal(show.data.pick.title, 'Andor');
  assert.ok(!('copyIds' in show.data.pick));

  assert.equal((await member<{ available: boolean }>('GET', '/api/watchwith/me')).data.available, true);
  await member('PUT', '/api/watchwith/me', { available: false });
  r = await admin('GET', '/api/watchwith/partners');
  assert.deepEqual(r.data, []);
  assert.equal((await admin('POST', '/api/watchwith/library', { partnerId: id })).status, 404);
  assert.equal((await admin('POST', '/api/watchwith/watchlist', { partnerId: id })).status, 404);
  const adminId = (await admin<{ user: { id: number } }>('GET', '/api/auth/status')).data.user.id;
  assert.equal((await member('POST', '/api/watchwith/library', { partnerId: adminId })).status, 200, 'hiding doesn’t stop you picking others');
  assert.equal((await member('PUT', '/api/watchwith/me', { available: 'yes' })).status, 400);
  await member('PUT', '/api/watchwith/me', { available: true });
});

test('Plex posters are resized by Plex, at a few fixed widths', async () => {
  const { requests } = m.mocks;
  let r = await admin('GET', `/api/media/${byTitle.Alien}/poster`);
  assert.equal(r.status, 200);
  assert.equal(r.body.length, PNG.length);
  assert.equal(r.headers['cache-control'], 'private, max-age=86400');
  assert.deepEqual(requests.transcodes.at(-1), {
    url: '/library/metadata/101/thumb/1',
    width: '600',
    height: '900',
    minSize: '1',
    upscale: '0',
    'X-Plex-Token': 'owner-token',
  });
  for (const [asked, sent] of [['1200', '1200'], ['5000', '1200'], ['100', '300'], ['abc', '600'], ['601', '1200']]) {
    await admin('GET', `/api/media/${byTitle.Alien}/poster?w=${asked}`);
    assert.equal(requests.transcodes.at(-1)!.width, sent, `?w=${asked}`);
  }
  r = await admin('GET', `/api/media/${byTitle.Heat}/poster`);
  assert.equal(r.body.length, BIG.length, 'the original when Plex can’t resize it');
  assert.equal((await admin('GET', '/api/media/99999/poster')).status, 404);
});

test('Jellyfin posters keep the server’s path prefix', async () => {
  const r = await admin('GET', `/api/media/${byTitle.Dune}/poster?w=1200`);
  assert.equal(r.status, 200);
  assert.equal(m.mocks.requests.jellyfin.at(-1), '/jf/Items/jf-dune/Images/Primary?maxWidth=1200');
});

test('the login backdrop shows small posters from across the library', async () => {
  const visitor = m.client();
  const { requests } = m.mocks;
  requests.transcodes.length = 0;
  requests.jellyfin.length = 0;
  for (let i = 0; i < 30; i++) {
    const r = await visitor('GET', '/api/backdrop');
    assert.equal(r.status, 200);
    assert.equal(r.headers['cache-control'], 'no-store');
  }
  assert.ok(requests.transcodes.every((t) => t.width === '300'));
  assert.ok(requests.jellyfin.every((q) => q.endsWith('maxWidth=300')));
  assert.ok(new Set(requests.transcodes.map((t) => t.url)).size >= 3);
});

test('now playing lists every server', async () => {
  const r = await admin<NowPlayingResponse>('GET', '/api/nowplaying');
  const bySource = Object.fromEntries(r.data.sessions.map((s) => [s.source, s]));
  assert.equal(bySource.plex?.title, 'Heat');
  assert.equal(bySource.plex?.mediaId, byTitle.Heat);
  assert.equal(bySource.jellyfin?.state, 'paused');
});

test('collections count the sync account’s watches for someone without history of their own', async () => {
  const r = await admin<CollectionProgress[]>('GET', '/api/collections');
  assert.equal(r.data.length, 1);
  assert.equal(r.data[0]!.itemCount, 2);
  assert.equal(r.data[0]!.watchedCount, 1);
});

test('the franchise scan carries on past franchises TMDb no longer has', async () => {
  // A franchise from an earlier scan that TMDb has since removed, and one that errors.
  m.db.$client.prepare("insert into tmdb_collections (tmdb_id, name, synced_at) values ('1', 'Gone', 0), ('2', 'Flaky', 0)").run();
  await admin('PUT', '/api/admin/settings', { tmdbApiKey: 'tmdb-key' });
  let r = await admin<TmdbScanStatus>('POST', '/api/admin/tmdb/scan', {});
  assert.equal(r.data.total, 4);
  for (let i = 0; i < 50 && r.data.running; i++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    r = await admin<TmdbScanStatus>('GET', '/api/admin/tmdb/scan');
  }
  assert.equal(r.data.running, false);
  assert.equal(r.data.processed, 4);
  assert.equal(r.data.errors, 1, 'only the erroring franchise');
  assert.equal(r.data.franchisesFound, 2, 'Alien, plus Flaky until it answers');
  for (const id of ['8091', '726871', '1', '2']) assert.ok(m.mocks.requests.tmdb.includes(`/3/collection/${id}`));

  const fr = (await admin<FranchisesResponse>('GET', '/api/franchises')).data.franchises;
  assert.deepEqual(fr.map((f) => [f.name, f.owned, f.total]), [['Alien Collection', 2, 4]]);
});

test('spinning a list skips titles gone from the server', async () => {
  const list = (await admin<{ id: number }>('POST', '/api/lists', { name: 'Two' })).data;
  await admin('POST', `/api/lists/${list.id}/items`, { mediaId: byTitle.Heat });
  await admin('POST', `/api/lists/${list.id}/items`, { mediaId: byTitle.Andor });
  m.db.$client.prepare('update media set removed_at = 1 where id = ?').run(byTitle.Andor);
  for (let i = 0; i < 10; i++) {
    assert.equal((await admin<MediaItem>('POST', '/api/media/random', { listId: list.id })).data.title, 'Heat');
  }
  assert.equal((await admin('POST', `/api/lists/${list.id}/random`, {})).status, 404, 'the old list-only endpoint is gone');
  m.db.$client.prepare('update media set removed_at = null where id = ?').run(byTitle.Andor);
});
