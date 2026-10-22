// Per-account failed-password backoff: the brute-force control that doesn't
// depend on request.ip, which a client behind a loosely trusted reverse proxy
// can choose (see config.ts). Rotating the address doesn't help an attacker
// here, because they have to name the account they're attacking.
//
// Deliberately in-memory and a cooldown, never a lock:
//   * the wait is capped (MAX_DELAY_MS), so no account is ever shut out;
//   * entries are forgotten after an hour of quiet, and on any success;
//   * only password sign-in is gated — Plex, SSO and passkeys stay open, so
//     an operator always has another way into their own instance;
//   * a restart clears everything, which is the safe direction to fail.
//
// Keys are lowercased to match the lower() unique index usernameIs() looks up
// with. Unknown usernames are counted too, so a throttled answer never reveals
// whether an account exists.

const FREE_ATTEMPTS = 5; // mistyping a password shouldn't cost a wait
const BASE_DELAY_MS = 2_000;
const MAX_DELAY_MS = 15 * 60 * 1000;
const IDLE_FORGET_MS = 60 * 60 * 1000;
const MAX_ENTRIES = 10_000; // bounds the map against username-rotating floods

const attempts = new Map<string, { failures: number; lastFailureAt: number }>();

export type ThrottleProvider = 'local' | 'jellyfin' | 'emby';

function keyFor(provider: ThrottleProvider, username: string): string {
  return `${provider}:${username.trim().toLowerCase()}`;
}

function delayFor(failures: number): number {
  if (failures <= FREE_ATTEMPTS) return 0;
  return Math.min(BASE_DELAY_MS * 2 ** (failures - FREE_ATTEMPTS - 1), MAX_DELAY_MS);
}

// Forget anything idle for an hour, then evict least-recent until under the
// cap. recordFailure re-inserts on every write, so iteration order is recency.
function evict(now: number) {
  for (const [key, entry] of attempts) {
    if (now - entry.lastFailureAt > IDLE_FORGET_MS) attempts.delete(key);
  }
  for (const key of attempts.keys()) {
    if (attempts.size < MAX_ENTRIES) break;
    attempts.delete(key);
  }
}

// Seconds before this account accepts another attempt, or 0 when it may go ahead.
export function retryAfterSeconds(provider: ThrottleProvider, username: string): number {
  const entry = attempts.get(keyFor(provider, username));
  if (!entry) return 0;
  const waited = Date.now() - entry.lastFailureAt;
  if (waited > IDLE_FORGET_MS) return 0;
  const remaining = delayFor(entry.failures) - waited;
  return remaining > 0 ? Math.ceil(remaining / 1000) : 0;
}

export function recordFailure(provider: ThrottleProvider, username: string) {
  const now = Date.now();
  if (attempts.size >= MAX_ENTRIES) evict(now);
  const key = keyFor(provider, username);
  const entry = attempts.get(key);
  // A long-idle entry starts over rather than resuming at its old delay.
  const failures = entry && now - entry.lastFailureAt <= IDLE_FORGET_MS ? entry.failures + 1 : 1;
  attempts.delete(key);
  attempts.set(key, { failures, lastFailureAt: now });
}

export function recordSuccess(provider: ThrottleProvider, username: string) {
  attempts.delete(keyFor(provider, username));
}
