import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { MediaItem, PollDetail } from '@marquee/shared';
import { api, ApiError } from '../api';
import { Modal } from './Modal';
import { Poster } from './Poster';

// Mirrors the server: 50 options, or 25 once the poll is on Discord (its button grid).
const optionLimit = (poll: PollDetail) => (poll.discordPosted ? 25 : 50);

// Edit a poll's title, description and options until voting closes. Option
// changes save right away; the text fields save with Save (or Done). Anyone
// viewing the poll sees each change live.
export function EditPollOptions({ poll, onClose }: { poll: PollDetail; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [title, setTitle] = useState(poll.title);
  const [description, setDescription] = useState(poll.description ?? '');
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const token = poll.shareToken;

  // With no search term, show a random sample of the library (same as New poll).
  const { data: results, refetch } = useQuery({
    queryKey: ['media', 'poll-edit', query],
    queryFn: () => api<MediaItem[]>(`/api/media?q=${encodeURIComponent(query)}${query ? '' : '&sort=random'}`),
  });

  const onSuccess = (data: PollDetail) => {
    setError(null);
    queryClient.setQueryData(['poll', token], data);
    queryClient.invalidateQueries({ queryKey: ['polls'] });
  };
  const onError = (err: unknown) => setError(err instanceof ApiError ? err.message : 'Something went wrong');

  const add = useMutation({
    mutationFn: (mediaId: number) => api<PollDetail>(`/api/polls/${token}/options`, { body: { mediaIds: [mediaId] } }),
    onSuccess,
    onError,
  });
  const remove = useMutation({
    mutationFn: (optionId: number) => api<PollDetail>(`/api/polls/${token}/options/${optionId}`, { method: 'DELETE' }),
    onSuccess,
    onError,
  });
  const saveDetails = useMutation({
    mutationFn: () =>
      api<PollDetail>(`/api/polls/${token}`, {
        method: 'PATCH',
        body: { title: title.trim(), description: description.trim() },
      }),
    onSuccess,
    onError,
  });

  const detailsChanged = title.trim() !== poll.title || description.trim() !== (poll.description ?? '');
  const canSaveDetails = detailsChanged && !!title.trim() && !saveDetails.isPending;
  // Done keeps unsaved title/description edits instead of silently dropping them.
  const done = () => {
    if (detailsChanged && title.trim()) saveDetails.mutate(undefined, { onSuccess: onClose });
    else onClose();
  };

  const busy = add.isPending || remove.isPending;
  const canRemove = poll.options.length > 2;
  const limit = optionLimit(poll);
  const full = poll.options.length >= limit;
  const inPoll = new Set(poll.options.map((o) => o.mediaId));

  return (
    <Modal wide onClose={onClose}>
      <div className="space-y-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="font-display text-xl text-neon-300">Edit poll</h2>
            {poll.status === 'open' && (
              <p className="mt-1 text-xs text-stone-500">
                Voting is open — changes show up for voters right away. Removing a title discards its votes.
              </p>
            )}
          </div>
          <button className="btn btn-ghost shrink-0" disabled={saveDetails.isPending} onClick={done}>
            Done
          </button>
        </div>

        {error && <p className="text-sm text-crimson-500">{error}</p>}

        <section className="space-y-3">
          <h3 className="text-xs font-semibold tracking-widest text-neon-500 uppercase">Details</h3>
          <input
            className="input"
            placeholder="Poll title, e.g. Friday Movie Night"
            maxLength={200}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <textarea
            className="input min-h-20"
            placeholder="Description (optional)"
            maxLength={2000}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          <div className="flex justify-end">
            <button className="btn btn-neon" disabled={!canSaveDetails} onClick={() => saveDetails.mutate()}>
              {saveDetails.isPending ? 'Saving…' : 'Save'}
            </button>
          </div>
        </section>

        <section className="border-t border-neon-500/10 pt-5">
          <h3 className="mb-3 text-xs font-semibold tracking-widest text-neon-500 uppercase">
            In this poll ({poll.options.length})
          </h3>
          <div className="grid grid-cols-3 gap-3 sm:grid-cols-5">
            {poll.options.map((o) => (
              <div key={o.id} className="relative">
                <button
                  className="absolute top-1.5 right-1.5 z-[1] flex h-8 w-8 items-center justify-center rounded-full bg-ink-950/80 text-crimson-500 backdrop-blur hover:bg-ink-950 disabled:opacity-40"
                  disabled={!canRemove || busy}
                  onClick={() => {
                    const n = o.votes;
                    if (
                      n === 0 ||
                      window.confirm(
                        `Remove “${o.title}”? Its ${n} vote${n === 1 ? '' : 's'} will be discarded and ${n === 1 ? 'that voter' : 'those voters'} can vote again.`,
                      )
                    ) {
                      remove.mutate(o.id);
                    }
                  }}
                  title={canRemove ? 'Remove from poll' : 'A poll needs at least two options'}
                  aria-label={`Remove ${o.title}`}
                >
                  ✕
                </button>
                <Poster mediaId={o.mediaId} title={o.title} className="rounded-lg" />
                <p className="mt-1 truncate text-xs text-stone-300">{o.title}</p>
                {o.votes > 0 && (
                  <p className="text-[11px] text-stone-500">
                    {o.votes} vote{o.votes === 1 ? '' : 's'}
                  </p>
                )}
              </div>
            ))}
          </div>
        </section>

        <section className="border-t border-neon-500/10 pt-5">
          <h3 className="mb-3 text-xs font-semibold tracking-widest text-neon-500 uppercase">Add from your library</h3>
          <div className="flex flex-wrap gap-2">
            <input
              className="input min-w-40 flex-1"
              placeholder="Search movies & shows…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {!query && (
              <button className="btn btn-ghost shrink-0" onClick={() => refetch()} title="Show a different random sample">
                Shuffle
              </button>
            )}
          </div>
          {full && (
            <p className="mt-2 text-xs text-stone-500">
              This poll has the maximum of {limit} options{poll.discordPosted ? ' for Discord' : ''} — remove one to add another.
            </p>
          )}
          <div className="mt-4 grid grid-cols-3 gap-3 sm:grid-cols-5">
            {results?.map((m) => {
              const added = inPoll.has(m.id);
              return (
                <button
                  key={m.id}
                  disabled={added || full || busy}
                  onClick={() => add.mutate(m.id)}
                  className="text-left disabled:cursor-default"
                  title={added ? 'Already in this poll' : 'Add to poll'}
                >
                  <Poster
                    mediaId={m.id}
                    title={m.title}
                    className={`rounded-lg transition-opacity ${added ? 'opacity-40 ring-2 ring-neon-400' : full ? 'opacity-60' : 'hover:opacity-80'}`}
                  />
                  <p className="mt-1 truncate text-xs text-stone-300">
                    {added && '✓ '}
                    {m.title} {m.year ? `(${m.year})` : ''}
                  </p>
                </button>
              );
            })}
            {results && results.length === 0 && <p className="col-span-full text-sm text-stone-400">Nothing found.</p>}
          </div>
        </section>
      </div>
    </Modal>
  );
}
