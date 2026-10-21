import crypto from 'node:crypto';
import { getSetting, setSetting } from '../settings.js';
import { serverUrl } from '../urls.js';
import { getMachineIdentifier } from './client.js';

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

export function buildAuthUrl(code: string, forwardUrl?: string): string {
  const params = new URLSearchParams({
    clientID: getClientId(),
    code,
    'context[device][product]': 'Marquee',
  });
  // After approval, plex.tv redirects the window here (lets the popup close itself).
  if (forwardUrl) params.set('forwardUrl', forwardUrl);
  return `https://app.plex.tv/auth#?${params.toString()}`;
}

// Returns the account token once the user has approved the PIN, else null.
export async function checkLoginPin(id: number): Promise<string | null> {
  const res = await fetch(`${PLEX_TV}/api/v2/pins/${id}`, { headers: plexTvHeaders() });
  if (!res.ok) throw new Error(`plex.tv PIN check failed (${res.status})`);
  const json = (await res.json()) as { authToken?: string | null };
  return json.authToken || null;
}

export async function getPlexAccount(token: string): Promise<{ id: number; username: string }> {
  const res = await fetch(`${PLEX_TV}/api/v2/user`, {
    headers: { ...plexTvHeaders(), 'X-Plex-Token': token },
  });
  if (!res.ok) throw new Error(`plex.tv account lookup failed (${res.status})`);
  const json = (await res.json()) as { id: number; username?: string; title?: string };
  return { id: json.id, username: json.username || json.title || `plex-${json.id}` };
}

// Plex Home ("managed users"): listed for the admin user-import only.
// Household sign-in was removed by design — a public login page must not
// enumerate household members.
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

// The configured server as plex.tv lists it for this account, or null when it
// isn't shared with them. Asked of plex.tv rather than the server itself: the
// server only accepts the owner's plex.tv token — shared and Home users get a
// separate per-server token from plex.tv — so probing it with their account
// token always fails.
async function findServerResource(
  server: { url: string; token: string },
  userToken: string,
): Promise<{ accessToken?: string } | null> {
  const machineId = (await getMachineIdentifier(server.url, server.token)) ?? getSetting('plex.machineId');
  if (!machineId) throw new Error('Could not identify the Plex server — check the Plex settings in Admin');
  const res = await fetch(`${PLEX_TV}/api/v2/resources?includeHttps=1`, {
    headers: { ...plexTvHeaders(), 'X-Plex-Token': userToken },
  });
  if (!res.ok) throw new Error(`plex.tv resources request failed (${res.status})`);
  const resources = (await res.json()) as { clientIdentifier?: string; provides?: string; accessToken?: string }[];
  return (
    resources.find((r) => r.clientIdentifier === machineId && (r.provides ?? '').split(',').includes('server')) ??
    null
  );
}

// The token to query the configured server as this account (so UserData is
// theirs) — the owner's own token, or the per-server token plex.tv issued a
// shared user — or null when the server isn't shared with them. Sign-in uses it
// as the gate: only the owner and accounts the server is shared with get in.
// The token counts only once the configured server itself has accepted it:
// plex.tv's list belongs to the account signing in, and a server's identifier
// isn't secret, so a look-alike server registered under the same identifier
// could appear in it. Only the real server accepts tokens for itself.
// Unreachable server → throws, so sign-in fails closed.
export async function getServerAccessToken(
  server: { url: string; token: string },
  userToken: string,
): Promise<string | null> {
  const accessToken = (await findServerResource(server, userToken))?.accessToken;
  if (!accessToken) return null;
  const res = await fetch(serverUrl(server.url, 'library/sections'), {
    headers: { 'X-Plex-Token': accessToken, Accept: 'application/json' },
  });
  if (res.ok) return accessToken;
  if (res.status === 401 || res.status === 403) return null;
  throw new Error(`Plex server access check failed (${res.status})`);
}
