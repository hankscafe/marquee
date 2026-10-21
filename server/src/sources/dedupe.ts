import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { media } from '../db/schema.js';

type MediaRow = typeof media.$inferSelect;

// What deduping looks at. Callers that draw from the whole library load just
// these columns (dedupeColumns), then fetch the one row they pick (fullRow).
export type DedupeFields = Pick<MediaRow, 'id' | 'source' | 'type' | 'title' | 'year' | 'tmdbId' | 'imdbId' | 'watched'>;
export type Deduped<T extends DedupeFields> = T & { copyIds: number[] };

export const dedupeColumns = {
  id: media.id,
  source: media.source,
  type: media.type,
  title: media.title,
  year: media.year,
  tmdbId: media.tmdbId,
  imdbId: media.imdbId,
  watched: media.watched,
};

// When the same title exists on more than one configured server, show it once.
// Copies are linked by any id they share — TMDb or IMDb — so a Plex copy with
// both and a Jellyfin copy with only an IMDb id still match; titles with no ids
// at all fall back to type+title+year. The copy from the highest-priority
// source wins, and a watch on ANY copy marks the survivor watched. copyIds lists
// every copy, for checks against per-copy data like a user's watched set.
const SOURCE_PRIORITY: Record<MediaRow['source'], number> = { plex: 0, jellyfin: 1, emby: 2 };

function keysOf(row: DedupeFields): string[] {
  const keys: string[] = [];
  if (row.tmdbId) keys.push(`t:${row.type}:${row.tmdbId}`); // TMDb movie and TV ids overlap
  if (row.imdbId) keys.push(`i:${row.imdbId}`);
  if (!keys.length) keys.push(`n:${row.type}:${row.title.toLowerCase()}:${row.year ?? ''}`);
  return keys;
}

export function dedupeMedia<T extends DedupeFields>(rows: T[]): Deduped<T>[] {
  // Union-find over the rows, joined through shared keys.
  const parent = rows.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]!]!;
    return i;
  };
  const firstWithKey = new Map<string, number>();
  rows.forEach((row, i) => {
    for (const key of keysOf(row)) {
      const j = firstWithKey.get(key);
      if (j === undefined) firstWithKey.set(key, i);
      else parent[find(i)] = find(j);
    }
  });

  const groups = new Map<number, T[]>();
  rows.forEach((row, i) => {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(row);
  });

  return [...groups.values()].map((copies) => {
    const keep = copies.reduce((best, r) => (SOURCE_PRIORITY[r.source] < SOURCE_PRIORITY[best.source] ? r : best));
    return { ...keep, watched: copies.some((r) => r.watched), copyIds: copies.map((r) => r.id) };
  });
}

// The whole row behind a title picked from deduped columns, keeping the
// watched flag merged across its copies.
export function fullRow(pick: Deduped<DedupeFields>): MediaRow | null {
  const row = db.select().from(media).where(eq(media.id, pick.id)).get();
  return row ? { ...row, watched: pick.watched } : null;
}
