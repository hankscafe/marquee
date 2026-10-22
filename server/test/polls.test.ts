import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { PollDetail, PollSummary, PublicPoll, WidgetPollsResponse } from '@marquee/shared';
import { signUp, startMarquee, withLibrary, type Client, type Marquee } from './support/harness.js';

let m: Marquee;
let admin: Client;
let member: Client;
let byTitle: Record<string, number>;
let friday: PollDetail;

before(async () => {
  m = await startMarquee();
  ({ admin, byTitle } = await withLibrary(m));
  ({ member } = await signUp(m, 'member'));
});
after(() => m.stop());

test('a poll is created open, with one option per title', async () => {
  const r = await admin<PollDetail>('POST', '/api/polls', {
    title: 'Friday',
    mediaIds: [byTitle.Alien, byTitle.Heat, byTitle.Dune, byTitle.Alien],
    openNow: true,
  });
  assert.equal(r.status, 201);
  friday = r.data;
  assert.equal(friday.status, 'open');
  assert.deepEqual(
    friday.options.map((o) => o.title),
    ['Alien (1979)', 'Heat (1995)', 'Dune (2021)'],
  );
  assert.ok(!('opensAt' in friday));
});

test('one vote per person', async () => {
  const [alien, heat] = friday.options;
  let r = await admin<PollDetail>('POST', `/api/polls/${friday.shareToken}/vote`, { optionId: alien!.id });
  assert.equal(r.status, 200);
  assert.equal(r.data.myVoteOptionId, alien!.id);
  r = await admin('POST', `/api/polls/${friday.shareToken}/vote`, { optionId: heat!.id });
  assert.equal(r.status, 409);
  r = await member('POST', `/api/polls/${friday.shareToken}/vote`, { optionId: alien!.id });
  assert.equal(r.status, 200);
});

test('guests vote once on a public link, under a name nobody else used', async () => {
  const [alien, heat] = friday.options;
  const shared = await admin<PollDetail>('POST', `/api/polls/${friday.shareToken}/public`, { enabled: true });
  const link = `/api/public/polls/${shared.data.publicToken}`;

  const guest = m.client();
  let r = await guest<PublicPoll>('POST', `${link}/vote`, { optionId: heat!.id, name: 'Sam' });
  assert.equal(r.status, 200);
  assert.equal(r.data.myVoteOptionId, heat!.id);
  r = await guest('POST', `${link}/vote`, { optionId: alien!.id, name: 'Sam again' });
  assert.equal(r.status, 409);

  const other = m.client();
  r = await other('POST', `${link}/vote`, { optionId: alien!.id, name: 'sam' });
  assert.equal(r.status, 409, 'names are compared without case');
  r = await other('POST', `${link}/vote`, { optionId: alien!.id });
  assert.equal(r.status, 400, 'a guest needs a name');

  r = await guest<PublicPoll>('GET', link);
  assert.equal(r.data.totalVotes, 3);
  assert.equal(r.data.voterName, 'Sam');
  r = await guest('GET', `${link}/options/${heat!.id}/poster`);
  assert.equal(r.status, 200);
});

test('the poll list counts every poll’s votes and hides other people’s drafts', async () => {
  const saturday = (
    await admin<PollDetail>('POST', '/api/polls', { title: 'Saturday', mediaIds: [byTitle.Aliens, byTitle.Arrival], openNow: true })
  ).data;
  await member('POST', `/api/polls/${saturday.shareToken}/vote`, { optionId: saturday.options[1]!.id });
  await admin('POST', '/api/polls', { title: 'Draft', mediaIds: [byTitle.Aliens, byTitle.Heat], openNow: false });

  let r = await admin<PollSummary[]>('GET', '/api/polls');
  const byName = Object.fromEntries(r.data.map((p) => [p.title, p]));
  assert.deepEqual(Object.keys(byName).sort(), ['Draft', 'Friday', 'Saturday']);
  assert.equal(byName.Friday!.voteCount, 3);
  assert.equal(byName.Friday!.optionCount, 3);
  assert.equal(byName.Friday!.options.find((o) => o.id === friday.options[0]!.id)!.votes, 2);
  assert.deepEqual(byName.Saturday!.options.map((o) => o.votes), [0, 1]);
  assert.equal(byName.Draft!.voteCount, 0);

  r = await member<PollSummary[]>('GET', '/api/polls');
  assert.deepEqual(r.data.map((p) => p.title).sort(), ['Friday', 'Saturday']);

  await admin('POST', `/api/polls/${saturday.shareToken}/pin`, { pinned: true });
  r = await admin<PollSummary[]>('GET', '/api/polls');
  assert.equal(r.data[0]!.title, 'Saturday', 'pinned polls come first');
});

test('the widget API needs its key, and never shows drafts', async () => {
  let r = await admin<{ apiKey: string }>('POST', '/api/admin/widget-key', {});
  const oldKey = r.data.apiKey;
  r = await admin<{ apiKey: string }>('POST', '/api/admin/widget-key', {});
  const key = r.data.apiKey;
  const widget = (k: string, query = '') => m.app.inject({ url: `/api/widget/polls${query}`, headers: { authorization: `Bearer ${k}` } });

  assert.equal((await widget(oldKey)).statusCode, 401, 'a rotated key stops working at once');
  await admin('POST', `/api/polls/${friday.shareToken}/spotlight`, { spotlight: true });
  let body = (await widget(key)).json<WidgetPollsResponse>();
  assert.equal(body.spotlight?.title, 'Friday');
  assert.equal(body.spotlight?.totalVotes, 3);
  assert.equal(body.spotlight?.leader?.votes, 2);
  assert.equal(body.spotlight?.url, `http://marquee.test/p/${friday.shareToken}`);
  assert.deepEqual(body.polls?.map((p) => p.title), ['Saturday']);

  body = (await widget(key, '?spotlight=1')).json<WidgetPollsResponse>();
  assert.equal(body.spotlight?.title, 'Friday');
  assert.ok(!('polls' in body));

  const draft = (await admin<PollSummary[]>('GET', '/api/polls')).data.find((p) => p.title === 'Draft')!;
  await admin('POST', `/api/polls/${draft.shareToken}/spotlight`, { spotlight: true });
  body = (await widget(key)).json<WidgetPollsResponse>();
  assert.equal(body.spotlight, null, 'a spotlighted draft stays private');
});

test('closing picks the most-voted title', async () => {
  const r = await admin<PollDetail>('POST', `/api/polls/${friday.shareToken}/close`, {});
  assert.equal(r.data.status, 'closed');
  assert.equal(r.data.winnerOptionId, friday.options[0]!.id);
  const vote = await member('POST', `/api/polls/${friday.shareToken}/vote`, { optionId: friday.options[1]!.id });
  assert.equal(vote.status, 409);
});

test('guest votes are capped per network and per poll', async () => {
  const sunday = (
    await admin<PollDetail>('POST', '/api/polls', { title: 'Sunday', mediaIds: [byTitle.Aliens, byTitle.Arrival], openNow: true })
  ).data;
  const link = `/api/public/polls/${(await admin<PollDetail>('POST', `/api/polls/${sunday.shareToken}/public`, { enabled: true })).data.publicToken}`;
  const optionId = sunday.options[0]!.id;
  const vote = (name: string, remoteAddress: string) =>
    m.app.inject({ method: 'POST', url: `${link}/vote`, payload: { optionId, name }, remoteAddress });

  for (let i = 1; i <= 10; i++) assert.equal((await vote(`Housemate ${i}`, '203.0.113.7')).statusCode, 200, `guest ${i}`);
  let r = await vote('Housemate 11', '203.0.113.7');
  assert.equal(r.statusCode, 429);
  assert.match(r.json().error, /from your network/);
  assert.equal((await vote('Neighbour', '198.51.100.7')).statusCode, 200, 'another network still votes');

  // Fill the poll up to its guest ceiling directly, then try once more from a fresh network.
  const sq = m.db.$client;
  const pollId = sunday.id;
  sq.transaction(() => {
    for (let i = 0; i < 189; i++) {
      const userId = sq.prepare("insert into users (username, guest_id, is_admin, created_at) values (?, ?, 0, 0) returning id").get(`filler-${i}`, `filler-${i}`) as { id: number };
      sq.prepare('insert into votes (poll_id, option_id, user_id, voter_name, voter_network, created_at) values (?, ?, ?, ?, ?, 0)').run(pollId, optionId, userId.id, `Filler ${i}`, `net-${i}`);
    }
  })();
  r = await vote('Latecomer', '192.0.2.99');
  assert.equal(r.statusCode, 429);
  assert.match(r.json().error, /all the guest votes/);
  assert.equal((await member('POST', `/api/polls/${sunday.shareToken}/vote`, { optionId })).status, 200, 'members can still vote');
});

test('one account can only hold a few live result streams open', async () => {
  const address = await m.app.listen({ port: 0, host: '127.0.0.1' });
  const login = await fetch(`${address}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'Admin', password: 'password123' }),
  });
  const cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const controller = new AbortController();
  const open = () => fetch(`${address}/api/polls/${friday.shareToken}/events`, { headers: { cookie }, signal: controller.signal });
  try {
    const streams = [];
    for (let i = 0; i < 8; i++) streams.push(await open());
    assert.ok(streams.every((s) => s.status === 200));
    assert.equal((await open()).status, 429);
  } finally {
    controller.abort();
  }
});
