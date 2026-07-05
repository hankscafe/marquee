import { eq } from 'drizzle-orm';
import { decryptSecret, encryptSecret, isEncrypted } from './crypto.js';
import { db } from './db/index.js';
import { settings, users } from './db/schema.js';
import { logger } from './logger.js';

// Settings whose values are secrets — encrypted at rest, decrypted on read.
const SECRET_KEYS = new Set([
  'plex.token',
  'jellyfin.apiKey',
  'emby.apiKey',
  'trakt.clientSecret',
  'tmdb.apiKey',
  'seerr.apiKey',
  'discord.botToken',
  'oidc.clientSecret',
]);

export function getSetting(key: string): string | null {
  const row = db.select().from(settings).where(eq(settings.key, key)).get();
  if (!row) return null;
  const value = SECRET_KEYS.has(key) ? decryptSecret(row.value) : row.value;
  return value || null;
}

export function setSetting(key: string, value: string) {
  const stored = SECRET_KEYS.has(key) && value ? encryptSecret(value) : value;
  db.insert(settings)
    .values({ key, value: stored })
    .onConflictDoUpdate({ target: settings.key, set: { value: stored } })
    .run();
}

// One-time upgrade: encrypt any secrets written before encryption-at-rest existed.
export function migrateSecretsAtRest() {
  let migrated = 0;
  for (const row of db.select().from(settings).all()) {
    if (SECRET_KEYS.has(row.key) && row.value && !isEncrypted(row.value)) {
      db.update(settings).set({ value: encryptSecret(row.value) }).where(eq(settings.key, row.key)).run();
      migrated++;
    }
  }
  // Per-user OAuth tokens too.
  for (const user of db.select().from(users).all()) {
    const update: Partial<{ plexToken: string; traktToken: string; traktRefresh: string }> = {};
    if (user.plexToken && !isEncrypted(user.plexToken)) update.plexToken = encryptSecret(user.plexToken);
    if (user.traktToken && !isEncrypted(user.traktToken)) update.traktToken = encryptSecret(user.traktToken);
    if (user.traktRefresh && !isEncrypted(user.traktRefresh)) update.traktRefresh = encryptSecret(user.traktRefresh);
    if (Object.keys(update).length) {
      db.update(users).set(update).where(eq(users.id, user.id)).run();
      migrated++;
    }
  }
  if (migrated > 0) logger.info({ migrated }, 'encrypted legacy plaintext secrets at rest');
}

export function getPlexConfig(): { url: string; token: string } | null {
  const url = getSetting('plex.url');
  const token = getSetting('plex.token');
  return url && token ? { url, token } : null;
}
