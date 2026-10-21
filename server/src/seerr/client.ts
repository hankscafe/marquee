import { getSetting } from '../settings.js';
import { serverUrl } from '../urls.js';

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

export async function testSeerr(cfg: SeerrConfig): Promise<void> {
  const target = serverUrl(cfg.url, cfg.kind === 'ombi' ? 'api/v1/Status' : 'api/v1/settings/main');
  const res = await fetch(target, { headers: { 'X-Api-Key': cfg.apiKey, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`${cfg.kind} responded ${res.status} — check the URL and API key`);
}

// Who in Marquee is asking, by the media-server accounts Seerr knows them by.
export interface Requester {
  isAdmin: boolean;
  plexId: string | null;
  jellyfinId: string | null;
  embyId: string | null;
}

interface SeerrUser {
  id: number;
  plexId?: number | null;
  jellyfinUserId?: string | null;
}

// Seerr's user list changes only when its admin adds people, so a short cache
// spares a lookup per request. Cleared whenever the request settings change.
const USER_CACHE_MS = 5 * 60_000;
let userCache: { at: number; users: SeerrUser[] } | null = null;

export function clearSeerrUserCache() {
  userCache = null;
}

async function seerrUsers(cfg: SeerrConfig): Promise<SeerrUser[]> {
  if (userCache && Date.now() - userCache.at < USER_CACHE_MS) return userCache.users;
  const users: SeerrUser[] = [];
  for (let skip = 0; ; skip += 100) {
    const res = await fetch(serverUrl(cfg.url, `api/v1/user?take=100&skip=${skip}`), {
      headers: { 'X-Api-Key': cfg.apiKey, Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`The request service responded ${res.status} while looking up its users`);
    const page = ((await res.json()) as { results?: SeerrUser[] }).results ?? [];
    users.push(...page);
    if (page.length < 100) break;
  }
  userCache = { at: Date.now(), users };
  return users;
}

// Jellyfin user ids show up with and without dashes depending on the API.
const sameJfId = (a: string | null | undefined, b: string | null) =>
  !!a && !!b && a.replace(/-/g, '').toLowerCase() === b.replace(/-/g, '').toLowerCase();

// The Overseerr/Jellyseerr account that is the same person: matched by Plex
// account id, or by Jellyfin/Emby user id (Jellyseerr).
export async function findSeerrUserId(cfg: SeerrConfig, who: Requester): Promise<number | null> {
  const match = (await seerrUsers(cfg)).find(
    (u) =>
      (who.plexId !== null && u.plexId != null && String(u.plexId) === who.plexId) ||
      sameJfId(u.jellyfinUserId, who.jellyfinId) ||
      sameJfId(u.jellyfinUserId, who.embyId),
  );
  return match?.id ?? null;
}

// Requests are made as the person's own Seerr account, so the permissions,
// auto-approval and quotas set there apply. Admins without a Seerr account
// request as the API key's owner, as before. Ombi has no per-user mapping
// here, so only admins can request through it.
export type RequestRoute = { allowed: true; asSeerrUser: number | null } | { allowed: false; reason: string };

export async function requestRoute(cfg: SeerrConfig, who: Requester): Promise<RequestRoute> {
  if (cfg.kind === 'ombi') {
    return who.isAdmin
      ? { allowed: true, asSeerrUser: null }
      : { allowed: false, reason: 'Requests through Ombi are limited to admins — ask one to request this' };
  }
  const seerrId = await findSeerrUserId(cfg, who);
  if (seerrId !== null) return { allowed: true, asSeerrUser: seerrId };
  if (who.isAdmin) return { allowed: true, asSeerrUser: null };
  return { allowed: false, reason: 'Your account isn’t set up in the request service yet — ask an admin to add you there' };
}

// Whether to show request buttons to this person. If Seerr can't be reached,
// show them and let the request itself explain what went wrong.
export async function canRequest(who: Requester): Promise<boolean> {
  const cfg = getSeerrConfig();
  if (!cfg) return false;
  try {
    return (await requestRoute(cfg, who)).allowed;
  } catch {
    return true;
  }
}

export async function requestMovie(cfg: SeerrConfig, tmdbId: number, asSeerrUser: number | null): Promise<void> {
  const target = serverUrl(cfg.url, cfg.kind === 'ombi' ? 'api/v1/Request/movie' : 'api/v1/request');
  const body = cfg.kind === 'ombi' ? { theMovieDbId: tmdbId } : { mediaType: 'movie', mediaId: tmdbId };
  const res = await fetch(target, {
    method: 'POST',
    headers: {
      'X-Api-Key': cfg.apiKey,
      'Content-Type': 'application/json',
      ...(asSeerrUser !== null ? { 'X-Api-User': String(asSeerrUser) } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 409) throw new Error('This title has already been requested');
  if (res.status === 403) throw new Error('The request service says your account isn’t allowed to request this');
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
