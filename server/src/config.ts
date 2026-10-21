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
const PRIVATE_NETWORKS = 'loopback,linklocal,uniquelocal';

function parseTrustProxy(v: string | undefined): boolean | string {
  if (v === undefined || v === '') return PRIVATE_NETWORKS;
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^\d+$/.test(v)) {
    // Fastify 5.12+ treats a hop count as "trust nothing" (it can't tell a proxy
    // from a client), which would put every user behind one proxy IP.
    logger.warn({ TRUST_PROXY: v }, 'TRUST_PROXY hop counts are no longer supported; trusting private networks instead');
    return PRIVATE_NETWORKS;
  }
  return v;
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
