import { getPlexConfig, setSetting } from '../settings.js';
import { mapLimit } from '../sources/mapLimit.js';
import type { NormalizedCollection, NormalizedItem, SourceSyncData } from '../sources/types.js';
import {
  getCollectionChildren,
  getMachineIdentifier,
  getSectionCollections,
  getSectionItems,
  getSections,
  isWatchedOnPlex,
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
  // Items matched by Plex's legacy agents have no Guid list, just one agent id.
  if (!imdbId && !tmdbId && item.guid) {
    imdbId = /agents\.imdb:\/\/(tt\d+)/.exec(item.guid)?.[1] ?? null;
    tmdbId = /agents\.themoviedb:\/\/(\d+)/.exec(item.guid)?.[1] ?? null;
  }
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
    watched: isWatchedOnPlex(item),
  };
}

const COLLECTION_CONCURRENCY = 8;

// Fetch everything from Plex up front (collection members a few at a time); the
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
  let collectionsComplete = true;

  for (const section of sections) {
    const metadata = await getSectionItems(cfg.url, cfg.token, section.key);
    for (const item of metadata) {
      if (item.type !== 'movie' && item.type !== 'show') continue;
      items.push(normalizeItem(item, section.title));
    }

    // Collections are optional (older servers may not expose the endpoint) — skip on
    // failure, and don't let the writer prune collections it simply didn't see.
    let plexCollections;
    try {
      plexCollections = await getSectionCollections(cfg.url, cfg.token, section.key);
    } catch {
      collectionsComplete = false;
      continue;
    }
    // A failed member fetch is null, not [], so the writer keeps that collection's members.
    const children = await mapLimit(plexCollections, COLLECTION_CONCURRENCY, (c) =>
      getCollectionChildren(cfg.url, cfg.token, c.ratingKey).catch(() => null),
    );
    plexCollections.forEach((c, i) => {
      collections.push({
        ratingKey: c.ratingKey,
        title: c.title,
        librarySection: section.title,
        childRatingKeys: children[i]?.map((ch) => ch.ratingKey) ?? null,
      });
    });
  }

  return { source: 'plex', serverId: machineId, sections: sections.length, items, collections, collectionsComplete };
}
