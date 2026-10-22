import { serverUrl } from '../urls.js';

export interface PlexSection {
  key: string;
  title: string;
  type: string;
}

export interface PlexItem {
  ratingKey: string;
  title: string;
  year?: number;
  type: string;
  thumb?: string;
  summary?: string;
  duration?: number;
  rating?: number;
  audienceRating?: number;
  contentRating?: string;
  viewCount?: number;
  lastViewedAt?: number; // epoch seconds; absent until something is watched
  leafCount?: number; // shows: total episodes
  viewedLeafCount?: number; // shows: watched episodes
  Genre?: { tag: string }[];
  Director?: { tag: string }[];
  Role?: { tag: string }[];
  Guid?: { id: string }[]; // e.g. imdb://tt0087469, tmdb://8681 (needs includeGuids=1)
  guid?: string; // legacy agents carry their one id here, e.g. com.plexapp.agents.imdb://tt0087469?lang=en
}

// Shows count as watched when every episode has been viewed; movies when viewed at least once.
export function isWatchedOnPlex(item: PlexItem): boolean {
  return item.type === 'show'
    ? (item.leafCount ?? 0) > 0 && (item.viewedLeafCount ?? 0) >= (item.leafCount ?? 0)
    : (item.viewCount ?? 0) > 0;
}

export interface PlexCollection {
  ratingKey: string;
  title: string;
}

// Without these, a stalled server holds each request for undici's 300 s header
// and body timeouts — and a sync makes dozens of requests while holding the
// "already running" guard. A whole-library listing is one large response, so
// it gets longer for big libraries on slow disks.
const REQUEST_TIMEOUT_MS = 30_000;
const LIBRARY_TIMEOUT_MS = 5 * 60_000;
const ARTWORK_TIMEOUT_MS = 15_000;

async function plexGet<T>(baseUrl: string, token: string, pathname: string, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
  const res = await fetch(serverUrl(baseUrl, pathname), {
    headers: { 'X-Plex-Token': token, Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`Plex request failed (${res.status} ${res.statusText})`);
  return res.json() as Promise<T>;
}

// The server's machine identifier, needed to build app.plex.tv deep links.
export async function getMachineIdentifier(baseUrl: string, token: string): Promise<string | null> {
  try {
    const json = await plexGet<{ MediaContainer?: { machineIdentifier?: string } }>(baseUrl, token, 'identity');
    return json?.MediaContainer?.machineIdentifier ?? null;
  } catch {
    return null;
  }
}

export async function getSections(baseUrl: string, token: string): Promise<PlexSection[]> {
  const json = await plexGet<{ MediaContainer?: { Directory?: PlexSection[] } }>(baseUrl, token, 'library/sections');
  return json?.MediaContainer?.Directory ?? [];
}

export async function getSectionItems(baseUrl: string, token: string, sectionKey: string): Promise<PlexItem[]> {
  const json = await plexGet<{ MediaContainer?: { Metadata?: PlexItem[] } }>(
    baseUrl,
    token,
    `library/sections/${encodeURIComponent(sectionKey)}/all?includeGuids=1`,
    LIBRARY_TIMEOUT_MS,
  );
  return json?.MediaContainer?.Metadata ?? [];
}

export async function getSectionCollections(
  baseUrl: string,
  token: string,
  sectionKey: string,
): Promise<PlexCollection[]> {
  const json = await plexGet<{ MediaContainer?: { Metadata?: PlexCollection[] } }>(
    baseUrl,
    token,
    `library/sections/${encodeURIComponent(sectionKey)}/collections`,
  );
  return json?.MediaContainer?.Metadata ?? [];
}

export async function getCollectionChildren(
  baseUrl: string,
  token: string,
  collectionRatingKey: string,
): Promise<PlexItem[]> {
  const json = await plexGet<{ MediaContainer?: { Metadata?: PlexItem[] } }>(
    baseUrl,
    token,
    `library/collections/${encodeURIComponent(collectionRatingKey)}/children`,
  );
  return json?.MediaContainer?.Metadata ?? [];
}

export interface PlexSession {
  title: string;
  type: string;
  ratingKey?: string;
  year?: number;
  viewOffset?: number;
  duration?: number;
  grandparentTitle?: string;
  grandparentRatingKey?: string;
  parentIndex?: number;
  index?: number;
  Player?: { state?: string };
  User?: { title?: string };
}

// Short timeout: this feeds the poster display's poll loop, which must stay snappy.
export async function getSessions(baseUrl: string, token: string): Promise<PlexSession[]> {
  const res = await fetch(serverUrl(baseUrl, 'status/sessions'), {
    headers: { 'X-Plex-Token': token, Accept: 'application/json' },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`Plex sessions request failed (${res.status})`);
  const json = (await res.json()) as { MediaContainer?: { Metadata?: PlexSession[] } };
  return json?.MediaContainer?.Metadata ?? [];
}

// Streams artwork through the server so the Plex token never reaches the browser.
// Plex keeps posters at full size (often 2000+ px tall), so its photo
// transcoder scales them to `width` first; if that fails, the original is sent.
export async function fetchArtwork(baseUrl: string, token: string, thumbPath: string, width: number): Promise<Response> {
  const original = serverUrl(baseUrl, thumbPath);
  // `thumb` is synced from the media server, but pin the host anyway: an absolute
  // path would otherwise let new URL() redirect the token-bearing request off-box.
  if (original.origin !== new URL(baseUrl).origin) throw new Error('refusing to fetch artwork from an unexpected host');
  original.searchParams.set('X-Plex-Token', token);

  const resized = serverUrl(baseUrl, 'photo/:/transcode');
  resized.search = new URLSearchParams({
    url: `/${thumbPath.replace(/^\/+/, '')}`, // the server's own path, whatever proxy prefix baseUrl has
    width: String(width),
    height: String(Math.round(width * 1.5)), // posters are 2:3
    minSize: '1',
    upscale: '0',
    'X-Plex-Token': token,
  }).toString();
  const res = await fetch(resized, { signal: AbortSignal.timeout(ARTWORK_TIMEOUT_MS) });
  if (res.ok) return res;
  void res.body?.cancel();
  return fetch(original, { signal: AbortSignal.timeout(ARTWORK_TIMEOUT_MS) });
}
