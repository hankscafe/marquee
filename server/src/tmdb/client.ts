import { getSetting } from '../settings.js';

// TMDb (themoviedb.org) — used only to discover movie collections ("franchises")
// so the Collections page can show titles missing from the library.
// The admin gets a free API key at https://www.themoviedb.org/settings/api.

const TMDB = 'https://api.themoviedb.org/3';

export function getTmdbKey(): string | null {
  return getSetting('tmdb.apiKey');
}

async function tmdbGet<T>(path: string, key: string): Promise<T> {
  const url = new URL(`${TMDB}/${path}`);
  url.searchParams.set('api_key', key);
  const res = await fetch(url);
  if (res.status === 401) throw new Error('TMDb rejected the API key — check it in Admin settings');
  if (!res.ok) throw new Error(`TMDb request failed (${res.status})`);
  return res.json() as Promise<T>;
}

export interface TmdbCollectionRef {
  id: number;
  name: string;
  poster_path?: string | null;
}

export async function getMovieCollectionRef(tmdbMovieId: string, key: string): Promise<TmdbCollectionRef | null> {
  const json = await tmdbGet<{ belongs_to_collection?: TmdbCollectionRef | null }>(`movie/${tmdbMovieId}`, key);
  return json.belongs_to_collection ?? null;
}

export interface TmdbPart {
  id: number;
  title: string;
  release_date?: string;
  poster_path?: string | null;
}

export async function getCollectionParts(collectionTmdbId: string, key: string): Promise<TmdbPart[]> {
  const json = await tmdbGet<{ parts?: TmdbPart[] }>(`collection/${collectionTmdbId}`, key);
  return json.parts ?? [];
}
