import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DiscordStatus, PollDetail } from '@marquee/shared';
import { api, ApiError } from '../api';
import { useAuth } from '../auth';
import { MediaDetailsModal } from '../components/MediaDetails';
import { Poster } from '../components/Poster';

export function PollPage() {
  const { token } = useParams<{ token: string }>();
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [detailsId, setDetailsId] = useState<number | null>(null);
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const { data: poll, isLoading } = useQuery({
    queryKey: ['poll', token],
    queryFn: () => api<PollDetail>(`/api/polls/${token}`),
    enabled: !!token,
  });
  const { data: discord } = useQuery({
    queryKey: ['discord'],
    queryFn: () => api<DiscordStatus>('/api/discord/status'),
    staleTime: 60_000,
  });

  // Live results: refetch whenever the server announces a change on this poll.
  useEffect(() => {
    if (!token) return;
    const source = new EventSource(`/api/polls/${token}/events`);
    source.onmessage = () => queryClient.invalidateQueries({ queryKey: ['poll', token] });
    return () => source.close();
  }, [token, queryClient]);

  const vote = useMutation({
    mutationFn: (optionId: number) => api<PollDetail>(`/api/polls/${token}/vote`, { body: { optionId } }),
    onSuccess: (data) => queryClient.setQueryData(['poll', token], data),
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Something went wrong'),
  });

  const { data: auth } = useAuth();

  const togglePin = useMutation({
    mutationFn: (pinned: boolean) => api<PollDetail>(`/api/polls/${token}/pin`, { body: { pinned } }),
    onSuccess: (data) => {
      queryClient.setQueryData(['poll', token], data);
      queryClient.invalidateQueries({ queryKey: ['polls'] });
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Could not update pin'),
  });

  const toggleSpotlight = useMutation({
    mutationFn: (spotlight: boolean) => api<PollDetail>(`/api/polls/${token}/spotlight`, { body: { spotlight } }),
    onSuccess: (data) => {
      queryClient.setQueryData(['poll', token], data);
      queryClient.invalidateQueries({ queryKey: ['polls'] });
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Could not update spotlight'),
  });

  const transition = useMutation({
    mutationFn: (action: 'open' | 'close') => api<PollDetail>(`/api/polls/${token}/${action}`, { body: {} }),
    onSuccess: (data) => {
      queryClient.setQueryData(['poll', token], data);
      queryClient.invalidateQueries({ queryKey: ['polls'] });
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Something went wrong'),
  });

  const postDiscord = useMutation({
    mutationFn: () => api<PollDetail>(`/api/polls/${token}/discord`, { body: {} }),
    onSuccess: (data) => queryClient.setQueryData(['poll', token], data),
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Could not post to Discord'),
  });

  const remove = useMutation({
    mutationFn: () => api(`/api/polls/${token}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['polls'] });
      navigate('/');
    },
  });

  const share = async () => {
    const url = window.location.href;
    if (navigator.share) {
      await navigator.share({ title: poll?.title, url }).catch(() => {});
    } else {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  if (isLoading) return <p className="text-stone-400">Loading…</p>;
  if (!poll) return <p className="text-stone-400">Poll not found.</p>;

  const canVote = poll.status === 'open' && poll.myVoteOptionId === null;
  const showResults = poll.myVoteOptionId !== null || poll.status === 'closed' || poll.isOwner;
  const winner = poll.options.find((o) => o.id === poll.winnerOptionId);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl text-neon-300">{poll.title}</h1>
          {poll.description && <p className="mt-1 text-stone-400">{poll.description}</p>}
          <p className="mt-2 text-sm text-stone-500">
            {poll.totalVotes} vote{poll.totalVotes === 1 ? '' : 's'}
            {poll.closesAt && poll.status === 'open' && <> · closes {new Date(poll.closesAt).toLocaleString()}</>}
            {poll.status === 'draft' && ' · draft (not yet open)'}
            {poll.status === 'closed' && ' · voting closed'}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button className="btn btn-ghost" onClick={share}>
            {copied ? 'Link copied!' : 'Share'}
          </button>
          {auth?.user?.isAdmin && (
            <button className="btn btn-ghost" disabled={togglePin.isPending} onClick={() => togglePin.mutate(!poll.pinned)}>
              {poll.pinned ? 'Unpin' : 'Pin'}
            </button>
          )}
          {auth?.user?.isAdmin && (
            <button
              className="btn btn-ghost"
              disabled={toggleSpotlight.isPending}
              onClick={() => toggleSpotlight.mutate(!poll.spotlight)}
              title="Feature this poll as the home-page spotlight"
            >
              {poll.spotlight ? 'Unspotlight' : 'Spotlight'}
            </button>
          )}
          {poll.isOwner && poll.status === 'draft' && (
            <button className="btn btn-neon" onClick={() => transition.mutate('open')}>
              Open voting
            </button>
          )}
          {poll.isOwner && poll.status === 'open' && discord?.connected && !poll.discordPosted && (
            <button
              className="btn btn-ghost"
              disabled={postDiscord.isPending}
              onClick={() => {
                setError(null);
                postDiscord.mutate();
              }}
            >
              {postDiscord.isPending ? 'Posting…' : 'Post to Discord'}
            </button>
          )}
          {poll.discordPosted && <span className="chip self-center bg-neon-500/15 text-neon-300">On Discord ✓</span>}
          {poll.isOwner && poll.status === 'open' && (
            <button className="btn btn-danger" onClick={() => transition.mutate('close')}>
              Close voting
            </button>
          )}
          {poll.isOwner && (
            <button
              className="btn btn-ghost"
              onClick={() => {
                if (window.confirm('Delete this poll? This cannot be undone.')) remove.mutate();
              }}
            >
              Delete
            </button>
          )}
        </div>
      </div>

      {poll.status === 'closed' && winner && (
        <div className="card border-neon-400/40 p-5 text-center">
          <p className="text-xs font-semibold tracking-widest text-neon-500 uppercase">Tonight’s feature</p>
          <p className="marquee-title mt-1 text-2xl">🏆 {winner.title}</p>
        </div>
      )}

      {canVote && <p className="text-sm text-neon-300">Tap a poster to cast your vote — you only get one!</p>}
      {error && <p className="text-sm text-crimson-500">{error}</p>}

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4">
        {poll.options.map((option) => {
          const pct = poll.totalVotes > 0 ? Math.round((option.votes / poll.totalVotes) * 100) : 0;
          const isMyVote = poll.myVoteOptionId === option.id;
          const isWinner = poll.winnerOptionId === option.id;
          return (
            <div key={option.id} className="relative">
              {option.mediaId !== null && (
                <button
                  className="absolute top-2 right-2 z-[1] flex h-9 w-9 items-center justify-center rounded-full bg-ink-950/80 text-neon-300 backdrop-blur hover:bg-ink-950"
                  onClick={() => setDetailsId(option.mediaId)}
                  title="About this title"
                  aria-label={`About ${option.title}`}
                >
                  ⓘ
                </button>
              )}
              <button
                disabled={!canVote || vote.isPending}
                onClick={() => {
                  setError(null);
                  vote.mutate(option.id);
                }}
                className={`card w-full overflow-hidden text-left transition-transform ${
                  canVote ? 'active:scale-95 hover:border-neon-400/60' : 'cursor-default'
                } ${isMyVote ? 'ring-2 ring-neon-400' : ''} ${isWinner ? 'border-neon-400/60' : ''}`}
              >
                <Poster mediaId={option.mediaId} title={option.title} />
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
            </div>
          );
        })}
      </div>

      <MediaDetailsModal mediaId={detailsId} onClose={() => setDetailsId(null)} />
    </div>
  );
}
