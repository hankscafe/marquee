import crypto from 'node:crypto';
import { config } from './config.js';

// AES-256-GCM for secrets at rest (integration API keys, user OAuth tokens).
// The key is derived from the instance secret, which lives in the data dir
// (or SESSION_SECRET) — so a copy of the database alone cannot expose tokens.
// Values are self-describing ("enc:v1:..."); plaintext legacy values pass
// through decryptSecret unchanged and get re-encrypted on their next write.

const key = crypto.createHash('sha256').update(`marquee-secrets:${config.sessionSecret}`).digest();
const PREFIX = 'enc:v1:';

export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
}

export function decryptSecret(stored: string): string {
  if (!stored.startsWith(PREFIX)) return stored; // legacy plaintext
  try {
    const raw = Buffer.from(stored.slice(PREFIX.length), 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  } catch {
    // wrong key (instance secret was replaced) — treat the secret as unset
    return '';
  }
}

export function isEncrypted(value: string): boolean {
  return value.startsWith(PREFIX);
}
