import { useEffect, useState, type ReactNode } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { MediaFilters, MediaItem } from '@marquee/shared';
import { api } from '../api';
import { Poster } from './Poster';

// How a title in the grid relates to what's being built: picked here (tap
// again to un-pick), already added (can't be picked twice), or available.
export type PickState = 'selected' | 'added' | 'available';

const SEARCH_DELAY_MS = 300;

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

// Search the library and pick titles from a poster grid — shared by New poll,
// Edit poll and Lists. The search waits for a pause in typing, and the last
// results stay on screen while the next ones load.
export function MediaPicker({
  stateOf,
  onPick,
  sample = false,
  filters = false,
  disabled = false,
  onDetails,
  placeholder = 'Search movies & shows…',
  labels = {},
  emptyText = 'Nothing found.',
  gridClassName = 'grid-cols-3 sm:grid-cols-5 md:grid-cols-6',
  children,
}: {
  stateOf: (item: MediaItem) => PickState;
  onPick: (item: MediaItem) => void;
  // With no search term, show a random sample of the library (and Shuffle) instead of nothing.
  sample?: boolean;
  // Library and genre dropdowns beside the search box.
  filters?: boolean;
  // Nothing more can be picked right now (the poll is full, or a change is saving).
  disabled?: boolean;
  // Adds an ⓘ button to each poster.
  onDetails?: (mediaId: number) => void;
  placeholder?: string;
  labels?: { pick?: string; added?: string };
  emptyText?: string;
  gridClassName?: string;
  // Shown between the search row and the grid.
  children?: ReactNode;
}) {
  const [query, setQuery] = useState('');
  const [section, setSection] = useState('');
  const [genre, setGenre] = useState('');
  const term = useDebouncedValue(query.trim(), SEARCH_DELAY_MS);
  const typed = query.trim().length > 0;

  const { data: libraryFilters } = useQuery({
    queryKey: ['media-filters'],
    queryFn: () => api<MediaFilters>('/api/media/filters'),
    enabled: filters,
  });

  const { data: results, refetch, isPlaceholderData } = useQuery({
    queryKey: ['media', 'search', term, section, genre],
    queryFn: () =>
      api<MediaItem[]>(
        `/api/media?q=${encodeURIComponent(term)}${term ? '' : '&sort=random'}` +
          (section ? `&section=${encodeURIComponent(section)}` : '') +
          (genre ? `&genre=${encodeURIComponent(genre)}` : ''),
      ),
    enabled: sample || term.length > 0,
    placeholderData: keepPreviousData,
  });
  // Without a sample, an empty search box shows nothing (not the last results).
  const showGrid = sample || typed;

  return (
    <div>
      <div className="flex flex-wrap gap-2">
        <input className="input min-w-40 flex-1" placeholder={placeholder} value={query} onChange={(e) => setQuery(e.target.value)} />
        {filters && (
          <>
            <select className="input w-auto" value={section} onChange={(e) => setSection(e.target.value)}>
              <option value="">All libraries</option>
              {libraryFilters?.sections.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <select className="input w-auto" value={genre} onChange={(e) => setGenre(e.target.value)}>
              <option value="">All genres</option>
              {libraryFilters?.genres.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </select>
          </>
        )}
        {sample && !typed && (
          <button className="btn btn-ghost shrink-0" onClick={() => refetch()} title="Show a different random sample">
            Shuffle
          </button>
        )}
      </div>
      {sample && !typed && (
        <p className="mt-2 text-xs text-stone-500">Showing a random sample of your library — search to find a specific title.</p>
      )}
      {children}
      {showGrid && (
        <div className={`mt-4 grid gap-3 transition-opacity ${gridClassName} ${isPlaceholderData ? 'opacity-60' : ''}`}>
          {results?.map((m) => {
            const state = stateOf(m);
            return (
              <div key={m.id} className="relative text-left">
                {onDetails && (
                  <button
                    className="absolute top-1.5 right-1.5 z-[1] flex h-8 w-8 items-center justify-center rounded-full bg-ink-950/80 text-neon-300 backdrop-blur hover:bg-ink-950"
                    onClick={() => onDetails(m.id)}
                    title="About this title"
                    aria-label={`About ${m.title}`}
                  >
                    ⓘ
                  </button>
                )}
                <button
                  onClick={() => onPick(m)}
                  disabled={state === 'added' || (disabled && state === 'available')}
                  className="w-full text-left disabled:cursor-default"
                  title={state === 'added' ? labels.added : labels.pick}
                >
                  <Poster
                    mediaId={m.id}
                    title={m.title}
                    className={`rounded-lg transition-opacity ${
                      state === 'selected'
                        ? 'ring-2 ring-neon-400'
                        : state === 'added'
                          ? 'opacity-40 ring-2 ring-neon-400'
                          : disabled
                            ? 'opacity-60'
                            : 'hover:opacity-80'
                    }`}
                  />
                  <p className="mt-1 truncate text-xs text-stone-300">
                    {state === 'added' && '✓ '}
                    {m.title} {m.year ? `(${m.year})` : ''}
                  </p>
                </button>
              </div>
            );
          })}
          {results && results.length === 0 && <p className="col-span-full text-sm text-stone-400">{emptyText}</p>}
        </div>
      )}
    </div>
  );
}
