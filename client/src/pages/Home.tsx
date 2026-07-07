import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { PollSummary } from '@marquee/shared';
import { api } from '../api';

const statusChip: Record<string, string> = {
  open: 'chip bg-neon-500/20 text-neon-300',
  draft: 'chip bg-stone-500/20 text-stone-400',
  closed: 'chip bg-violet-500/20 text-violet-400',
};

function PinIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="inline h-4 w-4 -translate-y-px text-neon-400"
      aria-hidden="true"
    >
      <path d="M12 17v5" />
      <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
    </svg>
  );
}

// Poster that fills its (variable-width) container — used in the weighted strip.
function PosterFill({ mediaId, title }: { mediaId: number | null; title: string }) {
  const [failed, setFailed] = useState(false);
  if (!mediaId || failed) {
    return <div className="flex h-full w-full items-center justify-center bg-ink-700 text-2xl">🎬</div>;
  }
  return (
    <img
      src={`/api/media/${mediaId}/poster`}
      alt={title}
      loading="lazy"
      onError={() => setFailed(true)}
      className="h-full w-full object-cover"
    />
  );
}

function PollCard({ poll }: { poll: PollSummary }) {
  const total = poll.options.reduce((a, o) => a + o.votes, 0);
  const winner = poll.status === 'closed' ? poll.options.find((o) => o.id === poll.winnerOptionId) : null;
  // Show the front-runners first so the strip reads left-to-right by popularity.
  const strip = [...poll.options].sort((a, b) => b.votes - a.votes).slice(0, 5);

  return (
    <Link to={`/p/${poll.shareToken}`} className="card block overflow-hidden transition-colors hover:border-neon-400/50">
      <div className="flex items-start justify-between gap-3 p-4 pb-2">
        <h3 className="font-display text-lg text-stone-100">
          {poll.pinned && (
            <span title="Pinned" className="mr-1.5">
              <PinIcon />
            </span>
          )}
          {poll.title}
        </h3>
        <span className={statusChip[poll.status]}>{poll.status}</span>
      </div>

      {winner ? (
        <div className="flex items-center gap-4 px-4 py-2">
          <div className="h-32 w-[5.3rem] shrink-0 overflow-hidden rounded-lg ring-1 ring-neon-400/50">
            <PosterFill mediaId={winner.mediaId} title={winner.title} />
          </div>
          <div className="min-w-0">
            <p className="text-xs font-semibold tracking-widest text-neon-500 uppercase">Winner</p>
            <p className="font-display truncate text-xl text-stone-100">🏆 {winner.title}</p>
            <p className="mt-1 text-sm text-stone-400">
              {winner.votes} of {total} vote{total === 1 ? '' : 's'}
              {total > 0 ? ` · ${Math.round((winner.votes / total) * 100)}%` : ''}
            </p>
          </div>
        </div>
      ) : (
        strip.length > 0 && (
          <div className="flex h-32 gap-1 px-4 py-2">
            {strip.map((o) => {
              const pct = total > 0 ? Math.round((o.votes / total) * 100) : 0;
              return (
                <div
                  key={o.id}
                  className="relative min-w-0 overflow-hidden rounded-md transition-all duration-500"
                  style={{ flexGrow: o.votes + 1, flexBasis: 0 }}
                  title={`${o.title} — ${o.votes} vote${o.votes === 1 ? '' : 's'}`}
                >
                  <PosterFill mediaId={o.mediaId} title={o.title} />
                  <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-ink-950/95 via-ink-950/60 to-transparent px-1 pt-5 pb-1 text-center text-[10px] leading-tight text-stone-200">
                    {o.votes} · {pct}%
                  </div>
                </div>
              );
            })}
          </div>
        )
      )}

      <p className="px-4 pt-1 pb-3 text-sm text-stone-400">
        {poll.optionCount} option{poll.optionCount === 1 ? '' : 's'} · {poll.voteCount} vote
        {poll.voteCount === 1 ? '' : 's'}
        {poll.closesAt && poll.status === 'open' && <> · closes {new Date(poll.closesAt).toLocaleString()}</>}
      </p>
    </Link>
  );
}

// The single admin-featured poll, rendered as a full-width hero at the top of
// the home page with live results (or the winner once it's closed).
function SpotlightWidget({ poll }: { poll: PollSummary }) {
  const queryClient = useQueryClient();
  useEffect(() => {
    const source = new EventSource(`/api/polls/${poll.shareToken}/events`);
    source.onmessage = () => queryClient.invalidateQueries({ queryKey: ['polls'] });
    return () => source.close();
  }, [poll.shareToken, queryClient]);

  const total = poll.options.reduce((a, o) => a + o.votes, 0);
  const winner = poll.status === 'closed' ? poll.options.find((o) => o.id === poll.winnerOptionId) : null;
  const strip = [...poll.options].sort((a, b) => b.votes - a.votes);
  const leader = strip[0];

  return (
    <Link
      to={`/p/${poll.shareToken}`}
      className="card block overflow-hidden border-neon-400/40 shadow-lg shadow-neon-500/10 transition-colors hover:border-neon-400/70"
    >
      <div className="flex items-center justify-between gap-3 border-b border-neon-500/15 bg-neon-500/5 px-5 py-2.5">
        <span className="text-xs font-semibold tracking-[0.28em] text-neon-400 uppercase">Spotlight</span>
        <span className={statusChip[poll.status]}>{poll.status}</span>
      </div>

      <div className="space-y-4 p-5">
        <h2 className="font-display text-2xl text-stone-100 sm:text-3xl">{poll.title}</h2>

        {winner ? (
          <div className="flex items-center gap-5">
            <div className="h-52 w-36 shrink-0 overflow-hidden rounded-lg ring-1 ring-neon-400/50">
              <PosterFill mediaId={winner.mediaId} title={winner.title} />
            </div>
            <div className="min-w-0">
              <p className="text-xs font-semibold tracking-widest text-neon-500 uppercase">Winner</p>
              <p className="font-display truncate text-2xl text-stone-100">🏆 {winner.title}</p>
              <p className="mt-1 text-sm text-stone-400">
                {winner.votes} of {total} vote{total === 1 ? '' : 's'}
                {total > 0 ? ` · ${Math.round((winner.votes / total) * 100)}%` : ''}
              </p>
            </div>
          </div>
        ) : (
          <>
            {strip.length > 0 && (
              <div className="flex h-48 gap-1.5">
                {strip.map((o) => {
                  const pct = total > 0 ? Math.round((o.votes / total) * 100) : 0;
                  return (
                    <div
                      key={o.id}
                      className="relative min-w-0 overflow-hidden rounded-md transition-all duration-500"
                      style={{ flexGrow: o.votes + 1, flexBasis: 0 }}
                      title={`${o.title} — ${o.votes} vote${o.votes === 1 ? '' : 's'}`}
                    >
                      <PosterFill mediaId={o.mediaId} title={o.title} />
                      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-ink-950/95 via-ink-950/60 to-transparent px-1 pt-6 pb-1 text-center text-[11px] leading-tight text-stone-200">
                        {o.votes} · {pct}%
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            <p className="text-sm text-stone-400">
              {poll.status === 'open' ? (
                <>
                  {total} vote{total === 1 ? '' : 's'} so far
                  {leader && total > 0 ? ` · leading: ${leader.title}` : ''} — tap to cast yours
                </>
              ) : (
                'Draft — not yet open for voting'
              )}
            </p>
          </>
        )}
      </div>
    </Link>
  );
}

export function Home() {
  const { data: polls, isLoading } = useQuery({
    queryKey: ['polls'],
    queryFn: () => api<PollSummary[]>('/api/polls'),
  });

  const spotlight = polls?.find((p) => p.spotlight);
  // The spotlight poll headlines its own hero, so keep it out of the lists below.
  const rest = polls?.filter((p) => p.id !== spotlight?.id) ?? [];
  const open = rest.filter((p) => p.status === 'open');
  const drafts = rest.filter((p) => p.status === 'draft');
  const closed = rest.filter((p) => p.status === 'closed');

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <h1 className="font-display text-2xl text-neon-300">Polls</h1>
        <Link to="/polls/new" className="btn btn-neon">
          + New poll
        </Link>
      </div>

      {isLoading && <p className="text-stone-400">Loading…</p>}

      {spotlight && <SpotlightWidget poll={spotlight} />}

      {!isLoading && !polls?.length && (
        <div className="card p-8 text-center">
          <p className="font-display text-xl text-stone-300">No polls yet</p>
          <p className="mt-2 text-sm text-stone-400">
            Create your first poll — or ask an admin to sync the media library so there are titles to pick from.
          </p>
        </div>
      )}

      {open.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-xs font-semibold tracking-widest text-neon-500 uppercase">Now showing</h2>
          <div className="grid gap-3 sm:grid-cols-2">{open.map((p) => <PollCard key={p.id} poll={p} />)}</div>
        </section>
      )}
      {drafts.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-xs font-semibold tracking-widest text-stone-500 uppercase">Coming soon (drafts)</h2>
          <div className="grid gap-3 sm:grid-cols-2">{drafts.map((p) => <PollCard key={p.id} poll={p} />)}</div>
        </section>
      )}
      {closed.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-xs font-semibold tracking-widest text-stone-500 uppercase">Past features</h2>
          <div className="grid gap-3 sm:grid-cols-2">{closed.map((p) => <PollCard key={p.id} poll={p} />)}</div>
        </section>
      )}
    </div>
  );
}
