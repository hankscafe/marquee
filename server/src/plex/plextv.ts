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

// Plex Home ("managed users"): list household members and switch to one,
// using the server owner's token. Managed users have no email/password —
// just an optional 4-digit PIN.
export interface PlexHomeUser {
  id: number;
  title: string;
  protected?: boolean;
  restricted?: boolean;
}

export async function getHomeUsers(ownerToken: string): Promise<PlexHomeUser[]> {
  const res = await fetch(`${PLEX_TV}/api/v2/home/users`, {
    headers: { ...plexTvHeaders(), 'X-Plex-Token': ownerToken },
  });
  if (!res.ok) throw new Error(`plex.tv home-users request failed (${res.status})`);
  const json = (await res.json()) as PlexHomeUser[] | { users?: PlexHomeUser[] };
  return Array.isArray(json) ? json : (json.users ?? []);
}

export async function switchToHomeUser(ownerToken: string, homeUserId: number, pin?: string): Promise<string> {
  const url = new URL(`${PLEX_TV}/api/v2/home/users/${homeUserId}/switch`);
  if (pin) url.searchParams.set('pin', pin);
  const res = await fetch(url, { method: 'POST', headers: { ...plexTvHeaders(), 'X-Plex-Token': ownerToken } });
  if (res.status === 401 || res.status === 403) throw new Error('INVALID_PIN');
  if (!res.ok) throw new Error(`plex.tv switch request failed (${res.status})`);
  const json = (await res.json()) as { authToken?: string };
  if (!json.authToken) throw new Error('plex.tv returned no token for that user');
  return json.authToken;
}

// Friends (accounts the owner shares the server with), for user import.
export interface PlexFriend {
  id: number;
  username?: string;
  title?: string;
}

export async function getFriends(ownerToken: string): Promise<PlexFriend[]> {
  const res = await fetch(`${PLEX_TV}/api/v2/friends`, {
    headers: { ...plexTvHeaders(), 'X-Plex-Token': ownerToken },
  });
  if (!res.ok) throw new Error(`plex.tv friends request failed (${res.status})`);
  const json = (await res.json()) as PlexFriend[] | { friends?: PlexFriend[] };
  return Array.isArray(json) ? json : (json.friends ?? []);
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
