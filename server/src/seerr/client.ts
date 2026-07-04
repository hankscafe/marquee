import { getSetting } from '../settings.js';

// Request-service integration. Overseerr and Jellyseerr share one API; Ombi has its own.

export interface SeerrConfig {
  url: string;
  apiKey: string;
  kind: 'overseerr' | 'ombi';
}

export function getSeerrConfig(): SeerrConfig | null {
  const url = getSetting('seerr.url');
  const apiKey = getSetting('seerr.apiKey');
  const kind = getSetting('seerr.kind') === 'ombi' ? 'ombi' : 'overseerr';
  return url && apiKey ? { url, apiKey, kind } : null;
}

function base(url: string): string {
  return url.replace(/\/+$/, '');
}

export async function testSeerr(cfg: SeerrConfig): Promise<void> {
  const target =
    cfg.kind === 'ombi' ? `${base(cfg.url)}/api/v1/Status` : `${base(cfg.url)}/api/v1/settings/main`;
  const res = await fetch(target, { headers: { 'X-Api-Key': cfg.apiKey, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`${cfg.kind} responded ${res.status} — check the URL and API key`);
}

export async function requestMovie(cfg: SeerrConfig, tmdbId: number): Promise<void> {
  const target = cfg.kind === 'ombi' ? `${base(cfg.url)}/api/v1/Request/movie` : `${base(cfg.url)}/api/v1/request`;
  const body = cfg.kind === 'ombi' ? { theMovieDbId: tmdbId } : { mediaType: 'movie', mediaId: tmdbId };
  const res = await fetch(target, {
    method: 'POST',
    headers: { 'X-Api-Key': cfg.apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 409) throw new Error('This title has already been requested');
  if (!res.ok) {
    let detail = '';
    try {
      detail = ((await res.json()) as { message?: string }).message ?? '';
    } catch {
      // non-JSON error body
    }
    throw new Error(`Request failed (${res.status})${detail ? `: ${detail}` : ''}`);
  }
}
