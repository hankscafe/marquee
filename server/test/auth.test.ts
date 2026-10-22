import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, test } from 'node:test';
import type { AuthStatus } from '@marquee/shared';
import { startMarquee, type Client, type Marquee } from './support/harness.js';

let m: Marquee;
let admin: Client;

// Signs in from a given address, to show which limits follow the account rather than the IP.
function login(username: string, password: string, remoteAddress = '127.0.0.1') {
  return m.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password }, remoteAddress });
}

before(async () => {
  m = await startMarquee();
  admin = m.client();
  await admin('POST', '/api/auth/setup', { username: 'Admin', password: 'password123' });
  await admin('PUT', '/api/admin/settings', { jellyfinUrl: m.mocks.urls.jellyfin, jellyfinApiKey: 'jf-key' });
});
after(() => m.stop());

test('registration is closed until an admin opens it', async () => {
  const visitor = m.client();
  assert.equal((await visitor<AuthStatus>('GET', '/api/auth/status')).data.authMethods.allowRegistration, false);
  assert.equal((await visitor('POST', '/api/auth/register', { username: 'newbie', password: 'password123' })).status, 403);

  await admin('PUT', '/api/admin/settings', { allowRegistration: true });
  assert.equal((await visitor('POST', '/api/auth/register', { username: 'newbie', password: 'password123' })).status, 201);
  await admin('PUT', '/api/admin/settings', { allowRegistration: false });
});

test('Jellyfin sign-ins only create accounts while registration is open', async () => {
  const jf = m.client();
  let r = await jf('POST', '/api/auth/jellyfin', { username: 'jfuser', password: 'jf-password' });
  assert.equal(r.status, 403);
  assert.match(r.data.error, /doesn’t create accounts/);

  await admin('PUT', '/api/admin/settings', { allowRegistration: true });
  assert.equal((await jf('POST', '/api/auth/jellyfin', { username: 'jfuser', password: 'jf-password' })).status, 200);
  await admin('PUT', '/api/admin/settings', { allowRegistration: false });

  // An account that already exists keeps signing in.
  const again = m.client();
  assert.equal((await again('POST', '/api/auth/jellyfin', { username: 'jfuser', password: 'jf-password' })).status, 200);
  assert.equal((await again('POST', '/api/auth/jellyfin', { username: 'jfuser', password: 'nope' })).status, 401);
});

test('failed passwords back off per account, whatever address they come from', async () => {
  for (let i = 1; i <= 6; i++) {
    const r = await login('Admin', 'wrong-password', `203.0.113.${i}`);
    assert.equal(r.statusCode, 401, `attempt ${i}`);
  }
  let r = await login('admin', 'password123', '203.0.113.50');
  assert.equal(r.statusCode, 429, 'even the right password waits out the cooldown');
  assert.match(r.json().error, /Too many failed sign-in attempts/);
  assert.ok(Number(r.headers['retry-after']) > 0);

  // Unknown usernames back off the same way, so a 429 confirms nothing.
  for (let i = 1; i <= 6; i++) await login('nobody', 'x', `198.51.100.${i}`);
  assert.equal((await login('nobody', 'x', '198.51.100.50')).statusCode, 429);

  await new Promise((resolve) => setTimeout(resolve, 2100));
  r = await login('Admin', 'password123', '203.0.113.60');
  assert.equal(r.statusCode, 200, 'the cooldown is short and passes');
  r = await login('Admin', 'wrong-password', '203.0.113.61');
  assert.equal(r.statusCode, 401, 'a success clears the count');
});

test('old password hashes still work and are upgraded on sign-in', async () => {
  const salt = crypto.randomBytes(16).toString('hex');
  const legacy = `scrypt:${salt}:${crypto.scryptSync('legacy-pass', salt, 64).toString('hex')}`;
  m.db.$client.prepare('insert into users (username, password_hash, is_admin, created_at) values (?, ?, 0, 0)').run('oldtimer', legacy);
  assert.equal((await login('oldtimer', 'legacy-pass')).statusCode, 200);
  const stored = (m.db.$client.prepare("select password_hash as h from users where username = 'oldtimer'").get() as { h: string }).h;
  assert.match(stored, /^scrypt2:32768:8:3:[0-9a-f]{32}:[0-9a-f]{128}$/);
  assert.equal((await login('oldtimer', 'legacy-pass')).statusCode, 200);
});

test('people can change their own password, which signs out their other browsers', async () => {
  const laptop = m.client();
  const phone = m.client();
  await admin('POST', '/api/admin/users', { username: 'pat', password: 'first-password' });
  await laptop('POST', '/api/auth/login', { username: 'pat', password: 'first-password' });
  await phone('POST', '/api/auth/login', { username: 'pat', password: 'first-password' });

  let r = await laptop('POST', '/api/auth/password', { currentPassword: 'not-it', newPassword: 'second-password' });
  assert.equal(r.status, 401);
  r = await laptop('POST', '/api/auth/password', { currentPassword: 'first-password', newPassword: 'short' });
  assert.equal(r.status, 400);
  r = await laptop<{ revokedSessions: number }>('POST', '/api/auth/password', { currentPassword: 'first-password', newPassword: 'second-password' });
  assert.equal(r.status, 200);
  assert.equal(r.data.revokedSessions, 1);

  assert.ok((await laptop<AuthStatus>('GET', '/api/auth/status')).data.user, 'this browser stays signed in');
  assert.equal((await phone<AuthStatus>('GET', '/api/auth/status')).data.user, null);
  assert.equal((await login('pat', 'first-password', '192.0.2.1')).statusCode, 401);
  assert.equal((await login('pat', 'second-password', '192.0.2.2')).statusCode, 200);

  const jf = m.client();
  await jf('POST', '/api/auth/jellyfin', { username: 'jfuser', password: 'jf-password' });
  r = await jf('POST', '/api/auth/password', { currentPassword: '', newPassword: 'whatever-123' });
  assert.equal(r.status, 409, 'accounts without a password have nothing to change');
});

test('signing in again replaces this browser’s old session', async () => {
  const browser = m.client();
  const count = () =>
    (m.db.$client.prepare("select count(*) as n from sessions s join users u on u.id = s.user_id where u.username = 'pat'").get() as { n: number }).n;
  await browser('POST', '/api/auth/login', { username: 'pat', password: 'second-password' });
  const before = count();
  await browser('POST', '/api/auth/login', { username: 'pat', password: 'second-password' });
  assert.equal(count(), before);
});

test('Plex sign-in hands back the code to compare, bound to this browser for 5 minutes', async () => {
  await admin('PUT', '/api/admin/settings', { plexUrl: m.mocks.urls.plex, plexToken: 'owner-token' });
  const browser = m.client();
  const r = await browser<{ code: string }>('POST', '/api/auth/plex/start', {});
  assert.equal(r.data.code, 'pin-code');
  assert.match(String(r.headers['set-cookie']), /marquee_plex_pin=.*Max-Age=300/);
});

test('passkeys, the Plex return link and Secure cookies come from the app URL alone', async () => {
  const browser = m.client();
  assert.equal((await browser('POST', '/api/auth/passkey/options', {})).status, 503, 'no app URL, no passkeys');
  let plex = await browser<{ authUrl: string }>('POST', '/api/auth/plex/start', {}, { host: 'evil.example' });
  assert.ok(!plex.data.authUrl.includes('forwardUrl'), 'no return link taken from the Host header');
  let cookie = String((await login('pat', 'second-password')).headers['set-cookie']);
  assert.ok(!/;\s*Secure/i.test(cookie), 'plain http and no app URL: not Secure');

  await admin('PUT', '/api/admin/settings', { appUrl: 'https://marquee.example.com/' });
  const options = await browser<{ rpId: string }>('POST', '/api/auth/passkey/options', {}, { host: 'evil.example' });
  assert.equal(options.status, 200);
  assert.equal(options.data.rpId, 'marquee.example.com');
  plex = await browser<{ authUrl: string }>('POST', '/api/auth/plex/start', {}, { host: 'evil.example' });
  const forward = new URLSearchParams(plex.data.authUrl.split('#?')[1]).get('forwardUrl');
  assert.equal(forward, 'https://marquee.example.com/login?plexDone=1');
  cookie = String((await login('pat', 'second-password', '192.0.2.10')).headers['set-cookie']);
  assert.match(cookie, /;\s*Secure/i, 'an https app URL marks cookies Secure even over a proxy that drops X-Forwarded-Proto');

  // A value that isn't a URL counts as unset rather than breaking anything.
  const { setSetting } = await import('../src/settings.js');
  setSetting('app.url', 'not a url'); // the Admin form would refuse it; an old or hand-edited row might not
  const settings = await admin<{ oidcRedirectUri: string | null }>('GET', '/api/admin/settings');
  assert.equal(settings.data.oidcRedirectUri, null);
  assert.equal((await browser('POST', '/api/auth/passkey/options', {})).status, 503);
});

test('Jellyfin users can be imported ahead of their first sign-in', async () => {
  const r = await admin<{ imported: number; skipped: number }>('POST', '/api/admin/users/import/jellyfin', {});
  assert.equal(r.status, 200, JSON.stringify(r.data));
  // admin is new; jfuser signed in earlier; the nameless account is left out.
  assert.deepEqual(r.data, { imported: 1, skipped: 1 });
  const again = await admin<{ imported: number; skipped: number }>('POST', '/api/admin/users/import/jellyfin', {});
  assert.deepEqual(again.data, { imported: 0, skipped: 2 }, 'safe to run again');

  // Matched by Jellyfin account id, never by name: the local "Admin" is untouched.
  const rows = m.db.$client.prepare("select username, jellyfin_id as jf from users where jellyfin_id = 'u1' or lower(username) = 'admin'").all() as { username: string; jf: string | null }[];
  assert.equal(rows.find((u) => u.username === 'Admin')?.jf, null);
  assert.ok(rows.some((u) => u.jf === 'u1' && u.username !== 'Admin'));

  assert.equal((await admin('POST', '/api/admin/users/import/emby', {})).status, 503);
  assert.equal((await admin('POST', '/api/admin/users/import/plexish', {})).status, 404);
  const member = m.client();
  await member('POST', '/api/auth/login', { username: 'pat', password: 'second-password' });
  assert.equal((await member('POST', '/api/admin/users/import/jellyfin', {})).status, 403);
});
