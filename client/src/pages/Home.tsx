import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { PollSummary } from '@marquee/shared';
import { api } from '../api';

const statusChip: Record<string, string> = {
  open: 'chip bg-gold-500/20 text-gold-300',
  draft: 'chip bg-stone-500/20 text-stone-400',
  closed: 'chip bg-crimson-500/20 text-crimson-500',
};

function PollCard({ poll }: { poll: PollSummary }) {
  return (
    <Link to={`/p/${poll.shareToken}`} className="card block p-4 transition-colors hover:border-gold-500/40">
      <div className="flex items-start justify-between gap-3">
        <h3 className="font-display text-lg text-stone-100">{poll.title}</h3>
        <span className={statusChip[poll.status]}>{poll.status}</span>
      </div>
      <p className="mt-2 text-sm text-stone-400">
        {poll.optionCount} option{poll.optionCount === 1 ? '' : 's'} · {poll.voteCount} vote
        {poll.voteCount === 1 ? '' : 's'}
        {poll.closesAt && poll.status === 'open' && (
          <> · closes {new Date(poll.closesAt).toLocaleString()}</>
        )}
      </p>
    </Link>
  );
}

export function Home() {
  const { data: polls, isLoading } = useQuery({
    queryKey: ['polls'],
    queryFn: () => api<PollSummary[]>('/api/polls'),
  });

  const open = polls?.filter((p) => p.status === 'open') ?? [];
  const drafts = polls?.filter((p) => p.status === 'draft') ?? [];
  const closed = polls?.filter((p) => p.status === 'closed') ?? [];

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <h1 className="font-display text-2xl text-gold-300">Polls</h1>
        <Link to="/polls/new" className="btn btn-gold">
          + New poll
        </Link>
      </div>

      {isLoading && <p className="text-stone-400">Loading…</p>}

      {!isLoading && !polls?.length && (
        <div className="card p-8 text-center">
          <p className="font-display text-xl text-stone-300">No polls yet</p>
          <p className="mt-2 text-sm text-stone-400">
            Create your first poll — or ask an admin to sync the Plex library so there are movies to pick from.
          </p>
        </div>
      )}

      {open.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-xs font-semibold tracking-widest text-gold-500 uppercase">Now showing</h2>
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
