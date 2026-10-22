import { getSetting } from '../settings.js';

// Trakt device-code OAuth (the "go to trakt.tv/activate and enter this code" flow)
// plus watched-history reads. The admin registers an API app at
// https://trakt.tv/oauth/applications and enters its client id/secret in Admin settings.

// Overridable so tests can point history sync at a fake Trakt.
const TRAKT = process.env.TRAKT_API_URL ?? 'https://api.trakt.tv';
const TIMEOUT_MS = 15_000;
// A long watch history is one big response.
const HISTORY_TIMEOUT_MS = 60_000;

export function getTraktApp(): { clientId: string; clientSecret: string } | null {
  const clientId = getSetting('trakt.clientId');
  const clientSecret = getSetting('trakt.clientSecret');
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

function traktHeaders(clientId: string, token?: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'trakt-api-version': '2',
    'trakt-api-key': clientId,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

export interface TraktDeviceCode {
  device_code: string;
  user_code: string;
  verification_url: string;
  interval: number;
}

export async function createDeviceCode(clientId: string): Promise<TraktDeviceCode> {
  const res = await fetch(`${TRAKT}/oauth/device/code`, {
    method: 'POST',
    headers: traktHeaders(clientId),
    body: JSON.stringify({ client_id: clientId }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Trakt device-code request failed (${res.status}) — check the client id in Admin settings`);
  return (await res.json()) as TraktDeviceCode;
}

export async function pollDeviceToken(
  clientId: string,
  clientSecret: string,
  deviceCode: string,
): Promise<{ accessToken: string; refreshToken: string } | 'pending'> {
  const res = await fetch(`${TRAKT}/oauth/device/token`, {
    method: 'POST',
    headers: traktHeaders(clientId),
    body: JSON.stringify({ code: deviceCode, client_id: clientId, client_secret: clientSecret }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 400) return 'pending';
  if (res.status === 404) throw new Error('Unknown Trakt code — start over');
  if (res.status === 409) throw new Error('That Trakt code was already used — start over');
  if (res.status === 410) throw new Error('The Trakt code expired — start over');
  if (res.status === 418) throw new Error('Trakt authorization was denied');
  if (!res.ok) throw new Error(`Trakt token request failed (${res.status})`);
  const json = (await res.json()) as { access_token: string; refresh_token: string };
  return { accessToken: json.access_token, refreshToken: json.refresh_token };
}

export async function refreshAccessToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<{ accessToken: string; refreshToken: string }> {
  const res = await fetch(`${TRAKT}/oauth/token`, {
    method: 'POST',
    headers: traktHeaders(clientId),
    body: JSON.stringify({
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: 'urn:ietf:wg:oauth:2.0:oob',
      grant_type: 'refresh_token',
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error('Your Trakt session expired — reconnect Trakt');
  const json = (await res.json()) as { access_token: string; refresh_token: string };
  return { accessToken: json.access_token, refreshToken: json.refresh_token };
}

export class TraktAuthError extends Error {}

export interface TraktIds {
  imdb?: string | null;
  tmdb?: number | null;
}

export async function getWatched(clientId: string, token: string, type: 'movies' | 'shows'): Promise<TraktIds[]> {
  // Shows would otherwise come with every season and episode watched — only the ids are used.
  const query = type === 'shows' ? '?extended=noseasons' : '';
  const res = await fetch(`${TRAKT}/sync/watched/${type}${query}`, {
    headers: traktHeaders(clientId, token),
    signal: AbortSignal.timeout(HISTORY_TIMEOUT_MS),
  });
  if (res.status === 401 || res.status === 403) throw new TraktAuthError('Trakt token rejected');
  if (!res.ok) throw new Error(`Trakt watched-${type} request failed (${res.status})`);
  const json = (await res.json()) as ({ movie?: { ids?: TraktIds } } & { show?: { ids?: TraktIds } })[];
  return json.map((entry) => (type === 'movies' ? entry.movie?.ids : entry.show?.ids) ?? {});
}
