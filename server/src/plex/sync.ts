import { getPlexConfig, setSetting } from '../settings.js';
import type { NormalizedCollection, NormalizedItem, SourceSyncData } from '../sources/types.js';
import {
  getCollectionChildren,
  getMachineIdentifier,
  getSectionCollections,
  getSectionItems,
  getSections,
  type PlexItem,
} from './client.js';

function normalizeItem(item: PlexItem, sectionTitle: string): NormalizedItem {
  const tags = (list?: { tag: string }[]) => (list?.length ? list.map((t) => t.tag) : null);
  let imdbId: string | null = null;
  let tmdbId: string | null = null;
  for (const guid of item.Guid ?? []) {
    if (guid.id.startsWith('imdb://')) imdbId = guid.id.slice(7);
    else if (guid.id.startsWith('tmdb://')) tmdbId = guid.id.slice(7);
  }
  // Shows count as watched when every episode has been viewed; movies when viewed at least once.
  const watched =
    item.type === 'show'
      ? (item.leafCount ?? 0) > 0 && (item.viewedLeafCount ?? 0) >= (item.leafCount ?? 0)
      : (item.viewCount ?? 0) > 0;
  return {
    ratingKey: item.ratingKey,
    title: item.title,
    year: item.year ?? null,
    type: item.type as 'movie' | 'show',
    thumb: item.thumb ?? null,
    summary: item.summary ?? null,
    durationMs: item.duration ?? null,
    librarySection: sectionTitle,
    genres: tags(item.Genre),
    imdbId,
    tmdbId,
    rating: item.audienceRating ?? item.rating ?? null,
    contentRating: item.contentRating ?? null,
    directors: tags(item.Director),
    actors: tags(item.Role),
    watched,
  };
}

// Fetch everything from Plex up front (collection members in parallel); the
// generic writer persists it afterwards in a single transaction.
export async function fetchPlexData(): Promise<SourceSyncData> {
  const cfg = getPlexConfig();
  if (!cfg) throw new Error('Plex is not configured. Set the server URL and token in Admin settings.');

  const machineId = await getMachineIdentifier(cfg.url, cfg.token);
  if (machineId) setSetting('plex.machineId', machineId);

  const sections = (await getSections(cfg.url, cfg.token)).filter(
    (s) => s.type === 'movie' || s.type === 'show',
  );

  const items: NormalizedItem[] = [];
  const collections: NormalizedCollection[] = [];

  for (const section of sections) {
    const metadata = await getSectionItems(cfg.url, cfg.token, section.key);
    for (const item of metadata) {
      if (item.type !== 'movie' && item.type !== 'show') continue;
      items.push(normalizeItem(item, section.title));
    }

    // Collections are optional (older servers may not expose the endpoint) — skip on failure.
    let plexCollections;
    try {
      plexCollections = await getSectionCollections(cfg.url, cfg.token, section.key);
    } catch {
      continue;
    }
    const children = await Promise.all(
      plexCollections.map((c) => getCollectionChildren(cfg.url, cfg.token, c.ratingKey).catch(() => [])),
    );
    plexCollections.forEach((c, i) => {
      collections.push({
        ratingKey: c.ratingKey,
        title: c.title,
        librarySection: section.title,
        childRatingKeys: children[i]!.map((ch) => ch.ratingKey),
      });
    });
  }

  return { source: 'plex', sections: sections.length, items, collections };
}
