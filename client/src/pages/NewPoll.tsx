import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CollectionDetail, CollectionProgress, MediaFilters, MediaItem, PollDetail } from '@marquee/shared';
import { api, ApiError } from '../api';
import { MediaDetailsModal } from '../components/MediaDetails';
import { Poster } from '../components/Poster';

export function NewPoll() {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<MediaItem[]>([]);
  const [closesAt, setClosesAt] = useState('');
  const [openNow, setOpenNow] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [detailsId, setDetailsId] = useState<number | null>(null);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [sectionFilter, setSectionFilter] = useState('');
  const [genreFilter, setGenreFilter] = useState('');
  const [collectionPick, setCollectionPick] = useState('');
  const { data: libraryFilters } = useQuery({
    queryKey: ['media-filters'],
    queryFn: () => api<MediaFilters>('/api/media/filters'),
  });
  const { data: collectionsList } = useQuery({
    queryKey: ['collections'],
    queryFn: () => api<CollectionProgress[]>('/api/collections'),
  });

  // Fill the poll from a server collection in one click (capped at the 50-option poll limit).
  const addCollection = useMutation({
    mutationFn: (id: number) => api<CollectionDetail>(`/api/collections/${id}`),
    onSuccess: (detail) => {
      setSelected((prev) => {
        const seen = new Set(prev.map((m) => m.id));
        const merged = [...prev];
        for (const item of detail.items) {
          if (!seen.has(item.id)) merged.push(item);
        }
        if (merged.length > 50) setError('Polls support up to 50 options — extra titles were left out');
        return merged.slice(0, 50);
      });
      setCollectionPick('');
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Could not load that collection'),
  });

  // With no search term, show a random sample of the library instead of A-to-Z.
  const { data: results, refetch } = useQuery({
    queryKey: ['media', query, sectionFilter, genreFilter],
    queryFn: () =>
      api<MediaItem[]>(
        `/api/media?q=${encodeURIComponent(query)}${query ? '' : '&sort=random'}` +
          (sectionFilter ? `&section=${encodeURIComponent(sectionFilter)}` : '') +
          (genreFilter ? `&genre=${encodeURIComponent(genreFilter)}` : ''),
      ),
  });

  const create = useMutation({
    mutationFn: () =>
      api<PollDetail>('/api/polls', {
        body: {
          title,
          description: description || undefined,
          mediaIds: selected.map((m) => m.id),
          closesAt: closesAt ? new Date(closesAt).toISOString() : undefined,
          openNow,
        },
      }),
    onSuccess: (poll) => {
      queryClient.invalidateQueries({ queryKey: ['polls'] });
      navigate(`/p/${poll.shareToken}`);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Something went wrong'),
  });

  const toggle = (item: MediaItem) =>
    setSelected((prev) =>
      prev.some((m) => m.id === item.id) ? prev.filter((m) => m.id !== item.id) : [...prev, item],
    );

  return (
    <div className="space-y-6">
      <h1 className="font-display text-2xl text-neon-300">New poll</h1>

      <div className="card space-y-4 p-5">
        <input className="input" placeholder="Poll title, e.g. Friday Movie Night" value={title} onChange={(e) => setTitle(e.target.value)} />
        <textarea
          className="input min-h-20"
          placeholder="Description (optional)"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        <div className="flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2 text-sm text-stone-300">
            <input type="checkbox" checked={openNow} onChange={(e) => setOpenNow(e.target.checked)} className="accent-neon-400" />
            Open voting immediately
          </label>
          <label className="flex items-center gap-2 text-sm text-stone-300">
            Auto-close at
            <input
              type="datetime-local"
              className="input w-auto"
              value={closesAt}
              onChange={(e) => setClosesAt(e.target.value)}
            />
          </label>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-3 border-t border-neon-500/10 pt-4">
          {error && <p className="text-sm text-crimson-500">{error}</p>}
          {selected.length < 2 && <p className="text-sm text-stone-500">Pick at least 2 titles below</p>}
          <button
            className="btn btn-neon"
            disabled={create.isPending || !title.trim() || selected.length < 2}
            onClick={() => {
              setError(null);
              create.mutate();
            }}
          >
            Create poll
          </button>
        </div>
      </div>

      {selected.length > 0 && (
        <div className="card p-5">
          <h2 className="mb-3 text-xs font-semibold tracking-widest text-neon-500 uppercase">
            Selected ({selected.length}) — tap to remove
          </h2>
          <div className="grid grid-cols-3 gap-3 sm:grid-cols-5 md:grid-cols-6">
            {selected.map((m) => (
              <div key={m.id} className="group relative text-left">
                <button
                  className="absolute top-1.5 right-1.5 z-[1] flex h-8 w-8 items-center justify-center rounded-full bg-ink-950/80 text-neon-300 backdrop-blur hover:bg-ink-950"
                  onClick={() => setDetailsId(m.id)}
                  title="About this title"
                  aria-label={`About ${m.title}`}
                >
                  ⓘ
                </button>
                <button onClick={() => toggle(m)} className="w-full text-left" title="Remove">
                  <Poster mediaId={m.id} title={m.title} className="rounded-lg ring-2 ring-neon-400 group-hover:opacity-60" />
                  <p className="mt-1 truncate text-xs text-stone-300">{m.title}</p>
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="card p-5">
        <h2 className="mb-3 text-xs font-semibold tracking-widest text-neon-500 uppercase">Add from your library</h2>
        {collectionsList && collectionsList.length > 0 && (
          <div className="mb-3 flex flex-wrap gap-2">
            <select
              className="input min-w-40 flex-1"
              value={collectionPick}
              onChange={(e) => setCollectionPick(e.target.value)}
            >
              <option value="">Add a whole collection…</option>
              {collectionsList.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title} ({c.itemCount})
                </option>
              ))}
            </select>
            <button
              className="btn btn-ghost shrink-0"
              disabled={!collectionPick || addCollection.isPending}
              onClick={() => addCollection.mutate(Number(collectionPick))}
            >
              {addCollection.isPending ? 'Adding…' : 'Add collection'}
            </button>
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <input
            className="input min-w-40 flex-1"
            placeholder="Search movies & shows…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <select className="input w-auto" value={sectionFilter} onChange={(e) => setSectionFilter(e.target.value)}>
            <option value="">All libraries</option>
            {libraryFilters?.sections.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <select className="input w-auto" value={genreFilter} onChange={(e) => setGenreFilter(e.target.value)}>
            <option value="">All genres</option>
            {libraryFilters?.genres.map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </select>
          {!query && (
            <button className="btn btn-ghost shrink-0" onClick={() => refetch()} title="Show a different random sample">
              Shuffle
            </button>
          )}
        </div>
        {!query && <p className="mt-2 text-xs text-stone-500">Showing a random sample of your library — search to find a specific title.</p>}
        <div className="mt-4 grid grid-cols-3 gap-3 sm:grid-cols-5 md:grid-cols-6">
          {results?.map((m) => {
            const isSelected = selected.some((s) => s.id === m.id);
            return (
              <div key={m.id} className="relative text-left">
                <button
                  className="absolute top-1.5 right-1.5 z-[1] flex h-8 w-8 items-center justify-center rounded-full bg-ink-950/80 text-neon-300 backdrop-blur hover:bg-ink-950"
                  onClick={() => setDetailsId(m.id)}
                  title="About this title"
                  aria-label={`About ${m.title}`}
                >
                  ⓘ
                </button>
                <button onClick={() => toggle(m)} className="w-full text-left">
                  <Poster
                    mediaId={m.id}
                    title={m.title}
                    className={`rounded-lg transition-opacity ${isSelected ? 'ring-2 ring-neon-400' : 'hover:opacity-80'}`}
                  />
                  <p className="mt-1 truncate text-xs text-stone-300">
                    {m.title} {m.year ? `(${m.year})` : ''}
                  </p>
                </button>
              </div>
            );
          })}
          {results && results.length === 0 && (
            <p className="col-span-full text-sm text-stone-400">
              Nothing found. Has an admin synced the Plex library yet?
            </p>
          )}
        </div>
      </div>

      <MediaDetailsModal mediaId={detailsId} onClose={() => setDetailsId(null)} />
    </div>
  );
}
