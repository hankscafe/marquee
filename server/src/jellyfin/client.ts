import crypto from 'node:crypto';
import { getSetting, setSetting } from '../settings.js';
import type { NormalizedCollection, NormalizedItem, SourceSyncData } from '../sources/types.js';

// Jellyfin and Emby share (essentially) one API — Jellyfin forked from Emby —
// so a single client covers both, parameterized by kind. Auth is an API key
// created in the server dashboard, sent as X-Emby-Token (accepted by both).

export type JfKind = 'jellyfin' | 'emby';

export function getJfConfig(kind: JfKind): { url: string; apiKey: string } | null {
  const url = getSetting(`${kind}.url`);
  const apiKey = getSetting(`${kind}.apiKey`);
  return url && apiKey ? { url, apiKey } : null;
}

function base(url: string): string {
  return url.replace(/\/+$/, '');
}

async function jfGet<T>(cfg: { url: string; apiKey: string }, path: string, timeoutMs?: number): Promise<T> {
  const res = await fetch(`${base(cfg.url)}${path}`, {
    headers: { 'X-Emby-Token': cfg.apiKey, Accept: 'application/json' },
    signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
  });
  if (res.status === 401) throw new Error('The server rejected the API key');
  if (!res.ok) throw new Error(`Request failed (${res.status} ${res.statusText})`);
  return res.json() as Promise<T>;
}

interface JfUser {
  Id: string;
  Name: string;
  Policy?: { IsAdministrator?: boolean };
}

// Watch state (UserData) is per-user; sync uses an admin user's perspective,
// mirroring how the Plex source uses the configured token's account.
async function pickUserId(cfg: { url: string; apiKey: string }): Promise<string> {
  const jfUsers = await jfGet<JfUser[]>(cfg, '/Users');
  if (!jfUsers.length) throw new Error('The server reported no users');
  const admin = jfUsers.find((u) => u.Policy?.IsAdministrator);
  return (admin ?? jfUsers[0]!).Id;
}

interface JfItem {
  Id: string;
  Name: string;
  Type: string;
  ProductionYear?: number;
  Overview?: string;
  RunTimeTicks?: number; // ticks are 100ns
  OfficialRating?: string;
  CommunityRating?: number;
  Genres?: string[];
  ProviderIds?: Record<string, string>;
  People?: { Name: string; Type: string }[];
  UserData?: { Played?: boolean };
  ImageTags?: Record<string, string>;
}

interface JfItemsResponse {
  Items?: JfItem[];
}

const ITEM_FIELDS = 'Genres,Overview,ProviderIds,People';

function providerId(item: JfItem, key: string): string | null {
  const ids = item.ProviderIds ?? {};
  for (const [k, v] of Object.entries(ids)) {
    if (k.toLowerCase() === key && v) return v;
  }
  return null;
}

function normalizeItem(item: JfItem, sectionTitle: string | null): NormalizedItem {
  const people = (type: string) => {
    const names = (item.People ?? []).filter((p) => p.Type === type).map((p) => p.Name);
    return names.length ? names.slice(0, 12) : null;
  };
  return {
    ratingKey: item.Id,
    title: item.Name,
    year: item.ProductionYear ?? null,
    type: item.Type === 'Series' ? 'show' : 'movie',
    thumb: item.ImageTags?.Primary ? item.Id : null,
    summary: item.Overview ?? null,
    durationMs: item.RunTimeTicks ? Math.round(item.RunTimeTicks / 10_000) : null,
    librarySection: sectionTitle,
    genres: item.Genres?.length ? item.Genres : null,
    imdbId: providerId(item, 'imdb'),
    tmdbId: providerId(item, 'tmdb'),
    rating: item.CommunityRating ?? null,
    contentRating: item.OfficialRating ?? null,
    directors: people('Director'),
    actors: people('Actor'),
    watched: !!item.UserData?.Played,
  };
}

export async function fetchJfData(kind: JfKind): Promise<SourceSyncData> {
  const cfg = getJfConfig(kind);
  if (!cfg) throw new Error(`${kind} is not configured`);

  // Server id enables web-app deep links.
  try {
    const info = await jfGet<{ Id?: string }>(cfg, '/System/Info');
    if (info?.Id) setSetting(`${kind}.serverId`, info.Id);
  } catch {
    // deep links just won't work; not fatal
  }

  const userId = await pickUserId(cfg);
  const views = await jfGet<{ Items?: { Id: string; Name: string; CollectionType?: string }[] }>(
    cfg,
    `/Users/${userId}/Views`,
  );
  const wanted = (views.Items ?? []).filter(
    (v) => v.CollectionType === 'movies' || v.CollectionType === 'tvshows',
  );

  const items: NormalizedItem[] = [];
  for (const view of wanted) {
    const res = await jfGet<JfItemsResponse>(
      cfg,
      `/Users/${userId}/Items?ParentId=${encodeURIComponent(view.Id)}&Recursive=true&IncludeItemTypes=Movie,Series&Fields=${ITEM_FIELDS}`,
    );
    for (const item of res.Items ?? []) {
      if (item.Type !== 'Movie' && item.Type !== 'Series') continue;
      items.push(normalizeItem(item, view.Name));
    }
  }

  // Box sets are the Jellyfin/Emby equivalent of Plex collections.
  const collections: NormalizedCollection[] = [];
  try {
    const boxSets = await jfGet<JfItemsResponse>(
      cfg,
      `/Users/${userId}/Items?IncludeItemTypes=BoxSet&Recursive=true`,
    );
    const children = await Promise.all(
      (boxSets.Items ?? []).map((b) =>
        jfGet<JfItemsResponse>(cfg, `/Users/${userId}/Items?ParentId=${encodeURIComponent(b.Id)}`).catch(
          () => ({ Items: [] as JfItem[] }),
        ),
      ),
    );
    (boxSets.Items ?? []).forEach((b, i) => {
      collections.push({
        ratingKey: b.Id,
        title: b.Name,
        librarySection: null,
        childRatingKeys: (children[i]!.Items ?? []).map((c) => c.Id),
      });
    });
  } catch {
    // box sets unavailable — sync items only
  }

  return { source: kind, sections: wanted.length, items, collections };
}

export interface JfSessionInfo {
  UserName?: string;
  PlayState?: { PositionTicks?: number; IsPaused?: boolean };
  NowPlayingItem?: {
    Id: string;
    Name: string;
    Type: string;
    RunTimeTicks?: number;
    ProductionYear?: number;
    SeriesName?: string;
    SeriesId?: string;
    ParentIndexNumber?: number;
    IndexNumber?: number;
  };
}

// Short timeout: this feeds the poster display's poll loop, which must stay snappy.
export async function fetchJfSessions(kind: JfKind): Promise<JfSessionInfo[]> {
  const cfg = getJfConfig(kind);
  if (!cfg) return [];
  return jfGet<JfSessionInfo[]>(cfg, '/Sessions', 5000);
}

export async function fetchJfArtwork(kind: JfKind, itemId: string): Promise<Response> {
  const cfg = getJfConfig(kind);
  if (!cfg) throw new Error(`${kind} is not configured`);
  return fetch(`${base(cfg.url)}/Items/${encodeURIComponent(itemId)}/Images/Primary?maxWidth=600`, {
    headers: { 'X-Emby-Token': cfg.apiKey },
  });
}

function deviceId(): string {
  let id = getSetting('app.deviceId');
  if (!id) {
    id = crypto.randomUUID();
    setSetting('app.deviceId', id);
  }
  return id;
}

// Username/password sign-in against the configured Jellyfin/Emby server.
// Throws Error('INVALID_CREDENTIALS') for bad logins; other errors are transport-level.
export async function authenticateJf(
  kind: JfKind,
  username: string,
  password: string,
): Promise<{ id: string; name: string }> {
  const cfg = getJfConfig(kind);
  if (!cfg) throw new Error(`${kind} sign-in is not enabled on this server`);
  const res = await fetch(`${base(cfg.url)}/Users/AuthenticateByName`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Emby-Authorization': `MediaBrowser Client="Marquee", Device="Marquee", DeviceId="${deviceId()}", Version="1.0"`,
    },
    body: JSON.stringify({ Username: username, Pw: password }),
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 401 || res.status === 403) throw new Error('INVALID_CREDENTIALS');
  if (!res.ok) throw new Error(`The ${kind} server responded ${res.status}`);
  const json = (await res.json()) as { User?: { Id: string; Name: string } };
  if (!json.User?.Id) throw new Error(`Unexpected response from the ${kind} server`);
  return { id: json.User.Id, name: json.User.Name };
}

export async function testJf(kind: JfKind): Promise<{ serverName: string; version: string }> {
  const cfg = getJfConfig(kind);
  if (!cfg) throw new Error(`Set the ${kind} URL and API key first`);
  const info = await jfGet<{ ServerName?: string; Version?: string }>(cfg, '/System/Info');
  return { serverName: info.ServerName ?? kind, version: info.Version ?? 'unknown' };
}
