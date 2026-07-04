import crypto from 'node:crypto';
import { getSetting, setSetting } from '../settings.js';

// plex.tv PIN-based OAuth ("Sign in with Plex"), the same flow Overseerr uses:
// create a PIN, send the user to app.plex.tv/auth to approve it, then poll the
// PIN until plex.tv attaches the account's auth token.

const PLEX_TV = 'https://plex.tv';

// A stable client identifier is required for the PIN flow; generate once and persist.
export function getClientId(): string {
  let id = getSetting('plex.clientId');
  if (!id) {
    id = crypto.randomUUID();
    setSetting('plex.clientId', id);
  }
  return id;
}

function plexTvHeaders(): Record<string, string> {
  return {
    Accept: 'application/json',
    'X-Plex-Product': 'Marquee',
    'X-Plex-Client-Identifier': getClientId(),
  };
}

export async function createLoginPin(): Promise<{ id: number; code: string }> {
  const res = await fetch(`${PLEX_TV}/api/v2/pins?strong=true`, {
    method: 'POST',
    headers: plexTvHeaders(),
  });
  if (!res.ok) throw new Error(`plex.tv PIN request failed (${res.status})`);
  const json = (await res.json()) as { id: number; code: string };
  return { id: json.id, code: json.code };
}

export function buildAuthUrl(code: string): string {
  const params = new URLSearchParams({
    clientID: getClientId(),
    code,
    'context[device][product]': 'Marquee',
  });
  return `https://app.plex.tv/auth#?${params.toString()}`;
}

// Returns the account token once the user has approved the PIN, else null.
export async function checkLoginPin(id: number): Promise<string | null> {
  const res = await fetch(`${PLEX_TV}/api/v2/pins/${id}`, { headers: plexTvHeaders() });
  if (!res.ok) throw new Error(`plex.tv PIN check failed (${res.status})`);
  const json = (await res.json()) as { authToken?: string | null };
  return json.authToken || null;
}

export async function getPlexAccount(
  token: string,
): Promise<{ id: number; username: string; thumb: string | null }> {
  const res = await fetch(`${PLEX_TV}/api/v2/user`, {
    headers: { ...plexTvHeaders(), 'X-Plex-Token': token },
  });
  if (!res.ok) throw new Error(`plex.tv account lookup failed (${res.status})`);
  const json = (await res.json()) as { id: number; username?: string; title?: string; thumb?: string };
  return { id: json.id, username: json.username || json.title || `plex-${json.id}`, thumb: json.thumb ?? null };
}

// Gate: only Plex accounts that can actually reach the admin's server may sign in.
export async function hasServerAccess(serverUrl: string, userToken: string): Promise<boolean> {
  try {
    const url = new URL('library/sections', serverUrl.endsWith('/') ? serverUrl : `${serverUrl}/`);
    const res = await fetch(url, { headers: { 'X-Plex-Token': userToken, Accept: 'application/json' } });
    return res.ok;
  } catch {
    return false;
  }
}
