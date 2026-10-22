import { getSetting } from '../settings.js';

// TMDb (themoviedb.org) — used only to discover movie collections ("franchises")
// so the Collections page can show titles missing from the library.
// The admin gets a free API key at https://www.themoviedb.org/settings/api.

// Overridable so tests can point the scan at a fake TMDb.
const TMDB = process.env.TMDB_API_URL ?? 'https://api.themoviedb.org/3';

export function getTmdbKey(): string | null {
  return getSetting('tmdb.apiKey');
}

async function tmdbGet<T>(path: string, key: string): Promise<T> {
  const url = new URL(`${TMDB}/${path}`);
  url.searchParams.set('api_key', key);
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
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

// TMDb's "recommendations" and "similar" lists for one title, merged (the first
// page of each — the strongest matches).
export async function getSimilarIds(type: 'movie' | 'tv', tmdbId: number, key: string): Promise<number[]> {
  const found = new Set<number>();
  for (const list of ['recommendations', 'similar'] as const) {
    const json = await tmdbGet<{ results?: { id?: number }[] }>(`${type}/${tmdbId}/${list}`, key);
    for (const result of json.results ?? []) if (typeof result.id === 'number') found.add(result.id);
  }
  return [...found];
}

export async function getCollectionParts(collectionTmdbId: string, key: string): Promise<TmdbPart[]> {
  const json = await tmdbGet<{ parts?: TmdbPart[] }>(`collection/${collectionTmdbId}`, key);
  return json.parts ?? [];
}
