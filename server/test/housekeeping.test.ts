import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { ScheduledPickInfo } from '@marquee/shared';
import { signUp, startMarquee, withLibrary, type Client, type Marquee } from './support/harness.js';

let m: Marquee;
let admin: Client;
let member: Client;
let memberId: number;

before(async () => {
  m = await startMarquee();
  ({ admin } = await withLibrary(m));
  ({ member, id: memberId } = await signUp(m, 'member'));
});
after(() => m.stop());

test('saving nothing is a 400, not a server error', async () => {
  const list = (await admin<{ id: number }>('POST', '/api/lists', { name: 'Faves' })).data;
  assert.equal((await admin('PATCH', `/api/lists/${list.id}`, {})).status, 400);
  assert.equal((await admin<{ isShared: boolean }>('PATCH', `/api/lists/${list.id}`, { isShared: true })).data.isShared, true);
  assert.equal((await admin('PATCH', `/api/admin/users/${memberId}`, {})).status, 400);
  assert.equal((await admin('PATCH', `/api/admin/users/${memberId}`, { isAdmin: false })).status, 200);
});

test('a weekly schedule needs a real time of day', async () => {
  for (const [time, status] of [['99:99', 400], ['24:00', 400], ['7:30', 400], ['23:59', 201], ['00:00', 201]] as const) {
    const r = await admin('POST', '/api/schedules', { name: time, kind: 'weekly', dayOfWeek: 5, timeOfDay: time, postToDiscord: false });
    assert.equal(r.status, status, time);
  }
});

test('“Run now” leaves a one-time schedule waiting for its date', async () => {
  const runAt = new Date(Date.now() + 86_400_000).toISOString();
  const once = (await admin<ScheduledPickInfo>('POST', '/api/schedules', { name: 'Once', kind: 'once', runAt, postToDiscord: false })).data;
  const r = await admin<{ title: string }>('POST', `/api/schedules/${once.id}/run`, {});
  assert.equal(r.status, 200);
  assert.ok(r.data.title);
  const after = (await admin<ScheduledPickInfo[]>('GET', '/api/schedules')).data.find((s) => s.id === once.id)!;
  assert.equal(after.enabled, true);
  assert.ok(after.lastRunAt);
});

test('sessions that can no longer be used are pruned', async () => {
  const { pruneSessions } = await import('../src/auth/plugin.js');
  const now = new Date();
  const ago = (minutes: number) => Math.floor((now.getTime() - minutes * 60_000) / 1000);
  const later = Math.floor(now.getTime() / 1000) + 86_400;
  const adminId = (await admin<{ user: { id: number } }>('GET', '/api/auth/status')).data.user.id;
  const insert = m.db.$client.prepare('insert into sessions (token, user_id, expires_at, last_seen_at) values (?, ?, ?, ?)');
  insert.run('admin-idle-3h', adminId, later, ago(180)); // past the 2-hour admin window
  insert.run('member-idle-3h', memberId, later, ago(180)); // inside the 6-hour member window
  insert.run('member-idle-7h', memberId, later, ago(420));
  insert.run('member-expired', memberId, ago(1), ago(5));
  insert.run('never-stamped', memberId, later, null);

  assert.equal(pruneSessions(now), 3);
  const planted = ['admin-idle-3h', 'member-idle-3h', 'member-idle-7h', 'member-expired', 'never-stamped'];
  const left = m.db.$client
    .prepare(`select token from sessions where token in (${planted.map(() => '?').join(', ')}) order by token`)
    .all(...planted) as { token: string }[];
  assert.deepEqual(left.map((r) => r.token), ['member-idle-3h', 'never-stamped']);
  // The real sessions of the signed-in clients are untouched.
  assert.ok((await admin<{ user: unknown }>('GET', '/api/auth/status')).data.user);
  assert.ok((await member<{ user: unknown }>('GET', '/api/auth/status')).data.user);
});

test('an idle session is signed out', async () => {
  m.db.$client.prepare('update sessions set last_seen_at = ? where user_id = ?').run(Math.floor(Date.now() / 1000) - 7 * 3600, memberId);
  const r = await member<{ user: unknown }>('GET', '/api/auth/status');
  assert.equal(r.data.user, null);
  assert.equal((await member('GET', '/api/polls')).status, 401);
});

test('pages carry a Content-Security-Policy that works over plain http', async () => {
  const csp = String((await admin('GET', '/api/health')).headers['content-security-policy']);
  for (const part of ["default-src 'self'", "script-src 'self'", "style-src 'self'", 'https://image.tmdb.org', "frame-ancestors 'self'", "object-src 'none'"]) {
    assert.ok(csp.includes(part), part);
  }
  assert.ok(!csp.includes('upgrade-insecure-requests'));
});

test('changes requested by another site’s page are refused', async () => {
  const cross = { 'sec-fetch-site': 'cross-site' };
  assert.equal((await admin('POST', '/api/lists', { name: 'Sneaky' }, cross)).status, 403);
  assert.equal((await admin('POST', '/api/lists', { name: 'Sibling' }, { 'sec-fetch-site': 'same-site' })).status, 403);
  assert.equal((await admin('POST', '/api/lists', { name: 'Mine' }, { 'sec-fetch-site': 'same-origin' })).status, 201);
  assert.equal((await admin('POST', '/api/lists', { name: 'Script' })).status, 201, 'no header: not a browser');
  assert.equal((await admin('GET', '/api/lists', undefined, cross)).status, 200, 'reads are fine');
});

test('a TRUST_PROXY that isn’t addresses falls back instead of breaking every request', async () => {
  const { parseTrustProxy } = await import('../src/config.js');
  const fallback = 'loopback,linklocal,uniquelocal';
  assert.equal(parseTrustProxy(undefined), fallback);
  assert.equal(parseTrustProxy('true'), true);
  assert.equal(parseTrustProxy('false'), false);
  assert.equal(parseTrustProxy('2'), fallback, 'hop counts');
  assert.equal(parseTrustProxy(' 172.18.0.0/16 , loopback '), '172.18.0.0/16,loopback');
  assert.equal(parseTrustProxy('10.0.0.0/255.0.0.0'), '10.0.0.0/255.0.0.0');
  assert.equal(parseTrustProxy('fd00::/8'), 'fd00::/8');
  assert.equal(parseTrustProxy('traefik'), fallback, 'a hostname');
  assert.equal(parseTrustProxy('10.0.0.1/8/9'), fallback);
  assert.equal(parseTrustProxy(','), fallback);
});

test('deleting a user recounts closed polls and keeps the lists they shared', async () => {
  const { member: leaver, id: leaverId } = await signUp(m, 'leaver');
  const { member: stayer } = await signUp(m, 'stayer');
  const ids = (await admin<{ id: number; title: string }[]>('GET', '/api/media?q=')).data;
  const id = (title: string) => ids.find((i) => i.title === title)!.id;
  const poll = (
    await admin<{ shareToken: string; options: { id: number }[] }>('POST', '/api/polls', { title: 'Decided', mediaIds: [id('Heat'), id('Arrival')], openNow: true })
  ).data;
  const [heat, arrival] = poll.options;
  await admin('POST', `/api/polls/${poll.shareToken}/vote`, { optionId: heat!.id });
  await leaver('POST', `/api/polls/${poll.shareToken}/vote`, { optionId: arrival!.id });
  await stayer('POST', `/api/polls/${poll.shareToken}/vote`, { optionId: arrival!.id });
  const closed = await admin<{ winnerOptionId: number }>('POST', `/api/polls/${poll.shareToken}/close`, {});
  assert.equal(closed.data.winnerOptionId, arrival!.id);
  const shared = (await leaver<{ id: number }>('POST', '/api/lists', { name: 'Shared picks', isShared: true })).data;
  const secret = (await leaver<{ id: number }>('POST', '/api/lists', { name: 'Guilty pleasures' })).data;

  assert.equal((await admin('DELETE', `/api/admin/users/${leaverId}`)).status, 204);
  // 1–1 now, and Heat got its vote first.
  const after = await admin<{ winnerOptionId: number }>('GET', `/api/polls/${poll.shareToken}`);
  assert.equal(after.data.winnerOptionId, heat!.id);
  const lists = (await admin<{ id: number; isOwner: boolean }[]>('GET', '/api/lists')).data;
  assert.equal(lists.find((l) => l.id === shared.id)?.isOwner, true, 'the shared list now belongs to the admin');
  const left = m.db.$client.prepare('select count(*) as n from lists where id = ?').get(secret.id) as { n: number };
  assert.equal(left.n, 0, 'a private list goes with its owner');
});
