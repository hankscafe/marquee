import crypto from 'node:crypto';

// Stored hashes name their own cost, so it can be raised later without locking
// anyone out: `scrypt2:<N>:<r>:<p>:<salt>:<hash>`. The original parameterless
// `scrypt:<salt>:<hash>` (Node's defaults, N=2^14) still verifies, and
// needsRehash marks it for an upgrade on the next successful sign-in — the only
// moment the plaintext is around.
const SCHEME = 'scrypt2';
const KEYLEN = 64;
// One of OWASP's equivalent scrypt settings, chosen for its smaller memory use
// (32 MiB per hash instead of 128) on small NAS boxes.
const COST = { N: 2 ** 15, r: 8, p: 3 };
const LEGACY_COST = { N: 2 ** 14, r: 8, p: 1 }; // Node's scryptSync defaults

type Cost = typeof COST;

// A corrupted or hostile row mustn't be able to ask for an arbitrarily large allocation.
const MAX_N = 2 ** 20;

// Hashing runs on libuv's thread pool: at this cost it takes long enough on a
// NAS that doing it on the main thread would stall every other request.
function scrypt(password: string, salt: string, cost: Cost): Promise<Buffer> {
  // scrypt needs about 128·N·r bytes, more than Node's default 32 MB limit allows here.
  const options = { ...cost, maxmem: 256 * cost.N * cost.r };
  return new Promise((resolve, reject) =>
    crypto.scrypt(password, salt, KEYLEN, options, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = (await scrypt(password, salt, COST)).toString('hex');
  return `${SCHEME}:${COST.N}:${COST.r}:${COST.p}:${salt}:${hash}`;
}

function parse(stored: string): { cost: Cost; salt: string; hash: string; current: boolean } | null {
  const parts = stored.split(':');
  if (parts[0] === SCHEME && parts.length === 6) {
    const [, n, r, p, salt, hash] = parts as [string, string, string, string, string, string];
    const cost = { N: Number(n), r: Number(r), p: Number(p) };
    const sane =
      Number.isInteger(cost.N) && cost.N > 1 && cost.N <= MAX_N && (cost.N & (cost.N - 1)) === 0 &&
      Number.isInteger(cost.r) && cost.r > 0 && cost.r <= 32 &&
      Number.isInteger(cost.p) && cost.p > 0 && cost.p <= 16;
    if (!sane || !salt || !hash) return null;
    return { cost, salt, hash, current: cost.N === COST.N && cost.r === COST.r && cost.p === COST.p };
  }
  if (parts[0] === 'scrypt' && parts.length === 3 && parts[1] && parts[2]) {
    return { cost: LEGACY_COST, salt: parts[1], hash: parts[2], current: false };
  }
  return null;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parse(stored);
  if (!parsed) return false;
  try {
    const candidate = await scrypt(password, parsed.salt, parsed.cost);
    const expected = Buffer.from(parsed.hash, 'hex');
    return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
  } catch {
    return false;
  }
}

// True when `stored` was written at a cost Marquee no longer issues.
export function needsRehash(stored: string): boolean {
  const parsed = parse(stored);
  return !!parsed && !parsed.current;
}
