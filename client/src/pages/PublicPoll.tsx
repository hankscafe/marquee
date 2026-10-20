import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PublicPoll as PublicPollData } from '@marquee/shared';
import { api, ApiError } from '../api';
import { MarqueeLogo } from '../components/MarqueeLogo';
import { Poster } from '../components/Poster';

// A poll shared at a public link: anyone can vote without an account. Guests
// give their name, and the server remembers this browser so it can't vote twice.
export function PublicPoll() {
  const { publicToken } = useParams<{ publicToken: string }>();
  // null until the visitor types, so a returning guest's saved name can prefill.
  const [name, setName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();
  const base = `/api/public/polls/${publicToken}`;
  const queryKey = ['public-poll', publicToken];

  const { data: poll, isLoading, error: loadError } = useQuery({
    queryKey,
    queryFn: () => api<PublicPollData>(base),
    enabled: !!publicToken,
    retry: false,
  });

  // Live results: refetch whenever the server announces a change on this poll.
  const loaded = !!poll;
  useEffect(() => {
    if (!loaded) return;
    const source = new EventSource(`${base}/events`);
    source.onmessage = () => queryClient.invalidateQueries({ queryKey: ['public-poll', publicToken] });
    return () => source.close();
  }, [loaded, base, publicToken, queryClient]);

  const voterName = name ?? poll?.voterName ?? '';
  const vote = useMutation({
    mutationFn: (optionId: number) =>
      api<PublicPollData>(`${base}/vote`, { body: { optionId, name: voterName.trim() || undefined } }),
    onSuccess: (data) => {
      setError(null);
      queryClient.setQueryData(queryKey, data);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Something went wrong'),
  });

  let content;
  if (isLoading) {
    content = <p className="text-stone-400">Loading…</p>;
  } else if (!poll) {
    content = <p className="text-stone-400">{loadError instanceof ApiError ? loadError.message : 'Poll not found.'}</p>;
  } else {
    const canVote = poll.status === 'open' && poll.myVoteOptionId === null;
    const needsName = canVote && !poll.signedIn;
    const showResults = poll.myVoteOptionId !== null || poll.status === 'closed';
    const winner = poll.options.find((o) => o.id === poll.winnerOptionId);

    const castVote = (optionId: number) => {
      if (needsName && !voterName.trim()) {
        setError('Enter your name first, then tap your pick.');
        nameInput.current?.focus();
        return;
      }
      setError(null);
      vote.mutate(optionId);
    };

    content = (
      <>
        <div>
          <h1 className="font-display text-2xl text-neon-300">{poll.title}</h1>
          {poll.description && <p className="mt-1 text-stone-400">{poll.description}</p>}
          <p className="mt-2 text-sm text-stone-500">
            {poll.totalVotes} vote{poll.totalVotes === 1 ? '' : 's'}
            {poll.closesAt && poll.status === 'open' && <> · closes {new Date(poll.closesAt).toLocaleString()}</>}
            {poll.status === 'closed' && ' · voting closed'}
          </p>
        </div>

        {poll.status === 'closed' && winner && (
          <div className="card border-neon-400/40 p-5 text-center">
            <p className="text-xs font-semibold tracking-widest text-neon-500 uppercase">Tonight’s feature</p>
            <p className="marquee-title mt-1 text-2xl">🏆 {winner.title}</p>
          </div>
        )}

        {needsName && (
          <div className="card space-y-2 p-4">
            <label htmlFor="voter-name" className="block text-sm text-stone-300">
              Your name
            </label>
            <input
              id="voter-name"
              ref={nameInput}
              className="input"
              maxLength={40}
              autoComplete="name"
              placeholder="e.g. Sam"
              value={voterName}
              onChange={(e) => setName(e.target.value)}
            />
            <p className="text-xs text-stone-500">Only the poll’s organizers see who voted.</p>
          </div>
        )}

        {canVote && <p className="text-sm text-neon-300">Tap a poster to cast your vote — you only get one!</p>}
        {poll.status === 'open' && poll.myVoteOptionId !== null && (
          <p className="text-sm text-stone-400">Thanks for voting! Results update live.</p>
        )}
        {error && <p className="text-sm text-crimson-500">{error}</p>}

        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4">
          {poll.options.map((option) => {
            const pct = poll.totalVotes > 0 ? Math.round((option.votes / poll.totalVotes) * 100) : 0;
            const isMyVote = poll.myVoteOptionId === option.id;
            const isWinner = poll.winnerOptionId === option.id;
            return (
              <button
                key={option.id}
                disabled={!canVote || vote.isPending}
                onClick={() => castVote(option.id)}
                className={`card w-full overflow-hidden text-left transition-transform ${
                  canVote ? 'active:scale-95 hover:border-neon-400/60' : 'cursor-default'
                } ${isMyVote ? 'ring-2 ring-neon-400' : ''} ${isWinner ? 'border-neon-400/60' : ''}`}
              >
                <Poster
                  mediaId={null}
                  title={option.title}
                  src={option.hasPoster ? `${base}/options/${option.id}/poster` : undefined}
                />
                <div className="space-y-2 p-3">
                  <p className="truncate text-sm font-medium text-stone-100">
                    {isWinner && '🏆 '}
                    {option.title}
                    {isMyVote && ' ✓'}
                  </p>
                  {showResults && (
                    <>
                      <div className="h-1.5 overflow-hidden rounded-full bg-ink-700">
                        <div className="h-full rounded-full bg-neon-400 transition-all" style={{ width: `${pct}%` }} />
                      </div>
                      <p className="text-xs text-stone-400">
                        {option.votes} vote{option.votes === 1 ? '' : 's'} · {pct}%
                      </p>
                    </>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      </>
    );
  }

  return (
    <div className="min-h-screen">
      <header className="border-b border-neon-500/15 bg-ink-950/85">
        <div className="mx-auto flex max-w-5xl items-center px-4 py-3 text-sm sm:text-base">
          <MarqueeLogo />
        </div>
      </header>
      <main className="mx-auto max-w-5xl space-y-6 px-4 py-6 pb-16">{content}</main>
    </div>
  );
}
