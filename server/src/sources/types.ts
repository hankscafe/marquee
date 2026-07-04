// Normalized shapes every media source (Plex, Jellyfin, Emby) maps into.
// Fetchers produce these; the generic writer persists them.

export type SourceKind = 'plex' | 'jellyfin' | 'emby';

export interface NormalizedItem {
  ratingKey: string;
  title: string;
  year: number | null;
  type: 'movie' | 'show';
  thumb: string | null; // source-specific artwork reference (Plex path / Jellyfin item id)
  summary: string | null;
  durationMs: number | null;
  librarySection: string | null;
  genres: string[] | null;
  imdbId: string | null;
  tmdbId: string | null;
  rating: number | null;
  contentRating: string | null;
  directors: string[] | null;
  actors: string[] | null;
  watched: boolean;
}

export interface NormalizedCollection {
  ratingKey: string;
  title: string;
  librarySection: string | null;
  childRatingKeys: string[];
}

export interface SourceSyncData {
  source: SourceKind;
  sections: number;
  items: NormalizedItem[];
  collections: NormalizedCollection[];
}
