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
  leafCount?: number; // shows: total episodes
  viewedLeafCount?: number; // shows: watched episodes
  Genre?: { tag: string }[];
  Director?: { tag: string }[];
  Role?: { tag: string }[];
  Guid?: { id: string }[]; // e.g. imdb://tt0087469, tmdb://8681 (needs includeGuids=1)
}

export interface PlexCollection {
  ratingKey: string;
  title: string;
}

// Plex paths are passed relative (no leading slash) so a base URL with a path prefix still works.
function plexUrl(baseUrl: string, pathname: string): URL {
  return new URL(pathname, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
}

async function plexGet<T>(baseUrl: string, token: string, pathname: string): Promise<T> {
  const res = await fetch(plexUrl(baseUrl, pathname), {
    headers: { 'X-Plex-Token': token, Accept: 'application/json' },
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
  const res = await fetch(plexUrl(baseUrl, 'status/sessions'), {
    headers: { 'X-Plex-Token': token, Accept: 'application/json' },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`Plex sessions request failed (${res.status})`);
  const json = (await res.json()) as { MediaContainer?: { Metadata?: PlexSession[] } };
  return json?.MediaContainer?.Metadata ?? [];
}

// Streams artwork through the server so the Plex token never reaches the browser.
export async function fetchArtwork(baseUrl: string, token: string, thumbPath: string): Promise<Response> {
  const base = new URL(baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  const url = new URL(thumbPath.replace(/^\/+/, ''), base);
  // `thumb` is synced from the media server, but pin the host anyway: an absolute
  // path would otherwise let new URL() redirect the token-bearing request off-box.
  if (url.origin !== base.origin) throw new Error('refusing to fetch artwork from an unexpected host');
  url.searchParams.set('X-Plex-Token', token);
  return fetch(url);
}
