import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

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

// How much to trust X-Forwarded-* headers. Defaults to true (the documented
// deployment sits behind a reverse proxy that sets them). Set TRUST_PROXY=false
// when exposing the server directly, otherwise a client can spoof its source IP
// via X-Forwarded-For and defeat the per-IP auth rate limits. Also accepts a hop
// count or a comma-separated IP/CIDR allowlist, passed through to Fastify.
function parseTrustProxy(v: string | undefined): boolean | number | string {
  if (v === undefined || v === '') return true;
  if (v === 'true') return true;
  if (v === 'false') return false;
  const n = Number(v);
  return Number.isInteger(n) ? n : v;
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
  dataDir,
  databasePath: process.env.DATABASE_PATH ?? path.join(dataDir, 'marquee.db'),
  sessionSecret: loadSessionSecret(),
  isProd: process.env.NODE_ENV === 'production',
};
