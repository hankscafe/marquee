import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { logger } from './logger.js';

// Anchor the default data dir to the server package itself (src/ and dist/ both sit
// one level below it) — NOT the process cwd. Launching from a different directory
// must never "lose" the database and present a fresh setup screen.
const packageRoot = path.resolve(import.meta.dirname, '..');
const dataDir = process.env.DATA_DIR ?? path.join(packageRoot, 'data');
fs.mkdirSync(dataDir, { recursive: true });

// Sessions survive restarts without forcing every deployment to set an env var:
// generate a secret once and persist it in the data directory.
function loadSessionSecret(): string {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const secretPath = path.join(dataDir, '.session-secret');
  if (fs.existsSync(secretPath)) return fs.readFileSync(secretPath, 'utf8').trim();
  const secret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(secretPath, secret, { mode: 0o600 });
  return secret;
}

// Which reverse proxies' X-Forwarded-* headers to believe (client IP for the
// per-IP rate limits, and https detection for secure cookies). By default, any
// proxy on a loopback or private address — where a self-hosted proxy lives (same
// host, Docker network or LAN). The client IP is then the right-most public
// address in X-Forwarded-For, which clients can't forge; a directly exposed
// server ignores the header entirely. `true` trusts the whole header, and since
// nginx, SWAG and Cloudflare pass a client-supplied X-Forwarded-For through,
// anyone could then pick their own IP. Also accepts a comma-separated IP/CIDR
// list (e.g. to add Cloudflare's ranges in front of nginx) or false.
//
// The default's catch: trusting a whole class of addresses means a client that
// reaches Marquee through a proxy on one of them (or from the LAN itself) can
// put anything in X-Forwarded-For and have it become request.ip. Anything keyed
// on the IP — the per-IP rate limits, the guest-vote network cap — can then be
// dodged. Defaulting to false would be worse: everyone behind a proxy would
// share its address, so one person's failed logins would rate-limit the house.
// So the controls that matter don't use the IP (the per-account backoff in
// auth/throttle.ts, the per-poll guest cap in polls/guests.ts), and operators
// who want trustworthy IPs pin TRUST_PROXY to their proxy (see README);
// warnIfProxyTrustIsLoose() says so at startup.
const PRIVATE_NETWORKS = 'loopback,linklocal,uniquelocal';

// Keywords proxy-addr understands alongside IP and CIDR entries.
const TRUST_KEYWORDS = new Set(['loopback', 'linklocal', 'uniquelocal']);
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

// Shape only — proxy-addr does the real parsing. This just has to catch a
// hostname or a typo before it becomes a 500 on every request.
function looksLikeAddress(entry: string): boolean {
  if (TRUST_KEYWORDS.has(entry)) return true;
  const [address = '', prefix, ...rest] = entry.split('/');
  if (rest.length) return false;
  // A prefix length, or the dotted-quad netmask proxy-addr also accepts.
  if (prefix !== undefined && !/^\d{1,3}$/.test(prefix) && !IPV4.test(prefix)) return false;
  return IPV4.test(address) || (address.includes(':') && /^[0-9a-f:.]+$/i.test(address));
}

export function parseTrustProxy(v: string | undefined): boolean | string {
  if (v === undefined || v === '') return PRIVATE_NETWORKS;
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^\d+$/.test(v)) {
    // Fastify 5.12+ treats a hop count as "trust nothing" (it can't tell a proxy
    // from a client), which would put every user behind one proxy IP.
    logger.warn({ TRUST_PROXY: v }, 'TRUST_PROXY hop counts are no longer supported; trusting private networks instead');
    return PRIVATE_NETWORKS;
  }
  // proxy-addr throws on a bad list at first use, which would be a 500 on
  // every request instead of a message at boot. Refuse it here and keep serving.
  const entries = v.split(',').map((e) => e.trim()).filter(Boolean);
  const bad = entries.filter((e) => !looksLikeAddress(e));
  if (!entries.length || bad.length) {
    logger.error({ TRUST_PROXY: v, invalid: bad }, 'TRUST_PROXY is not a list of IPs, CIDRs or keywords; trusting private networks instead');
    return PRIVATE_NETWORKS;
  }
  return entries.join(',');
}

// Idle auto-logout windows, in minutes. Admins get a shorter window than
// regular users. Overridable via env for stricter or looser deployments.
function idleMinutes(envVar: string, fallback: number): number {
  const n = Number(process.env[envVar]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function readVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '../package.json'), 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const config = {
  version: readVersion(),
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? '0.0.0.0',
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
  adminIdleMinutes: idleMinutes('ADMIN_IDLE_MINUTES', 120), // 2 hours
  userIdleMinutes: idleMinutes('USER_IDLE_MINUTES', 360), // 6 hours
  databasePath: process.env.DATABASE_PATH ?? path.join(dataDir, 'marquee.db'),
  sessionSecret: loadSessionSecret(),
};

// Say at startup when the effective TRUST_PROXY lets a client choose its own
// IP address, with the fix.
export function warnIfProxyTrustIsLoose() {
  if (config.trustProxy === true) {
    logger.warn(
      "TRUST_PROXY=true believes any X-Forwarded-For, so every client picks its own IP address. Set TRUST_PROXY to your reverse proxy's address or subnet instead.",
    );
  } else if (config.trustProxy === PRIVATE_NETWORKS) {
    logger.warn(
      { TRUST_PROXY: PRIVATE_NETWORKS },
      'Trusting X-Forwarded-For from any private address: a client reaching Marquee through a proxy on one can choose its own IP, weakening per-IP rate limits. Pin TRUST_PROXY to your proxy (e.g. TRUST_PROXY=172.18.0.0/16) — see the README.',
    );
  }
}
