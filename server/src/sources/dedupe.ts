import type { media } from '../db/schema.js';

type MediaRow = typeof media.$inferSelect;

// When the same title exists on more than one configured server, show it once.
// Matched by TMDb id, then IMDb id, then type+title+year; the copy from the
// highest-priority source wins, but a watch on ANY copy marks the survivor watched.
const SOURCE_PRIORITY: Record<MediaRow['source'], number> = { plex: 0, jellyfin: 1, emby: 2 };

function dedupeKey(row: MediaRow): string {
  if (row.tmdbId) return `t:${row.type}:${row.tmdbId}`;
  if (row.imdbId) return `i:${row.imdbId}`;
  return `n:${row.type}:${row.title.toLowerCase()}:${row.year ?? ''}`;
}

export function dedupeMedia(rows: MediaRow[]): MediaRow[] {
  const byKey = new Map<string, MediaRow>();
  for (const row of rows) {
    const key = dedupeKey(row);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, row);
      continue;
    }
    const keep = SOURCE_PRIORITY[row.source] < SOURCE_PRIORITY[existing.source] ? row : existing;
    byKey.set(key, { ...keep, watched: row.watched || existing.watched });
  }
  return [...byKey.values()];
}
