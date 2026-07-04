import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { MediaItem, PollDetail } from '@marquee/shared';
import { api, ApiError } from '../api';
import { Poster } from '../components/Poster';

export function NewPoll() {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<MediaItem[]>([]);
  const [closesAt, setClosesAt] = useState('');
  const [openNow, setOpenNow] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // With no search term, show a random sample of the library instead of A-to-Z.
  const { data: results, refetch } = useQuery({
    queryKey: ['media', query],
    queryFn: () =>
      api<MediaItem[]>(`/api/media?q=${encodeURIComponent(query)}${query ? '' : '&sort=random'}`),
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
      <h1 className="font-display text-2xl text-gold-300">New poll</h1>

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
            <input type="checkbox" checked={openNow} onChange={(e) => setOpenNow(e.target.checked)} className="accent-gold-400" />
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
        <div className="flex flex-wrap items-center justify-end gap-3 border-t border-gold-500/10 pt-4">
          {error && <p className="text-sm text-crimson-500">{error}</p>}
          {selected.length < 2 && <p className="text-sm text-stone-500">Pick at least 2 titles below</p>}
          <button
            className="btn btn-gold"
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
          <h2 className="mb-3 text-xs font-semibold tracking-widest text-gold-500 uppercase">
            Selected ({selected.length}) — tap to remove
          </h2>
          <div className="grid grid-cols-3 gap-3 sm:grid-cols-5 md:grid-cols-6">
            {selected.map((m) => (
              <button key={m.id} onClick={() => toggle(m)} className="group text-left" title="Remove">
                <Poster mediaId={m.id} title={m.title} className="rounded-lg ring-2 ring-gold-400 group-hover:opacity-60" />
                <p className="mt-1 truncate text-xs text-stone-300">{m.title}</p>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="card p-5">
        <h2 className="mb-3 text-xs font-semibold tracking-widest text-gold-500 uppercase">Add from your library</h2>
        <div className="flex gap-2">
          <input className="input" placeholder="Search movies & shows…" value={query} onChange={(e) => setQuery(e.target.value)} />
          {!query && (
            <button className="btn btn-ghost shrink-0" onClick={() => refetch()} title="Show a different random sample">
              🎲 Shuffle
            </button>
          )}
        </div>
        {!query && <p className="mt-2 text-xs text-stone-500">Showing a random sample of your library — search to find a specific title.</p>}
        <div className="mt-4 grid grid-cols-3 gap-3 sm:grid-cols-5 md:grid-cols-6">
          {results?.map((m) => {
            const isSelected = selected.some((s) => s.id === m.id);
            return (
              <button key={m.id} onClick={() => toggle(m)} className="text-left">
                <Poster
                  mediaId={m.id}
                  title={m.title}
                  className={`rounded-lg transition-opacity ${isSelected ? 'ring-2 ring-gold-400' : 'hover:opacity-80'}`}
                />
                <p className="mt-1 truncate text-xs text-stone-300">
                  {m.title} {m.year ? `(${m.year})` : ''}
                </p>
              </button>
            );
          })}
          {results && results.length === 0 && (
            <p className="col-span-full text-sm text-stone-400">
              Nothing found. Has an admin synced the Plex library yet?
            </p>
          )}
        </div>
      </div>

    </div>
  );
}
