import { config } from './config.js';
import { logger } from './logger.js';

export const REPO_URL = 'https://github.com/hankscafe/marquee';
// Overridable so tests can point the check at a fake release feed.
const RELEASES_URL = process.env.UPDATE_CHECK_URL ?? 'https://api.github.com/repos/hankscafe/marquee/releases/latest';
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

let latest: { version: string; url: string } | null = null;

function parseVersion(v: string): number[] {
  return v
    .replace(/^v/, '')
    .split('.')
    .map((n) => Number.parseInt(n, 10) || 0);
}

function isNewer(candidate: string, current: string): boolean {
  const [a, b] = [parseVersion(candidate), parseVersion(current)];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return false;
}

export async function checkForUpdate(): Promise<void> {
  try {
    const res = await fetch(RELEASES_URL, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': `marquee/${config.version}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return; // rate-limited or no releases yet — retry next interval
    const release = (await res.json()) as { tag_name?: string; html_url?: string };
    if (release.tag_name && isNewer(release.tag_name, config.version)) {
      latest = { version: release.tag_name.replace(/^v/, ''), url: release.html_url ?? `${REPO_URL}/releases` };
      logger.info({ latest: latest.version, current: config.version }, 'marquee update available');
    } else {
      latest = null;
    }
  } catch (err) {
    // Network/GitHub being down should never affect the app.
    logger.debug({ err }, 'update check failed');
  }
}

export function getUpdateInfo(): { version: string; url: string } | null {
  return latest;
}

export function startUpdateChecker() {
  void checkForUpdate();
  setInterval(() => void checkForUpdate(), CHECK_INTERVAL_MS).unref();
}
