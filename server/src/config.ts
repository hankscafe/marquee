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
  dataDir,
  databasePath: process.env.DATABASE_PATH ?? path.join(dataDir, 'marquee.db'),
  sessionSecret: loadSessionSecret(),
  isProd: process.env.NODE_ENV === 'production',
};
