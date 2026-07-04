import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import type {
  WatchedMethod,
  WatchWithLibraryResult,
  WatchWithPartner,
  WatchWithWatchlistResult,
} from '@marquee/shared';
import { api, ApiError } from '../api';
import { MediaFacts } from '../components/MediaDetails';
import { Poster } from '../components/Poster';

type Mode = 'library' | 'watchlist';
type TypeFilter = 'all' | 'movie' | 'show';

const methodLabel: Record<WatchedMethod, string> = {
  trakt: 'Trakt history',
  plex: 'their Plex history',
  'sync-account': "the server account's history",
};

export function WatchWith() {
  const [partnerId, setPartnerId] = useState<number | null>(null);
  const [mode, setMode] = useState<Mode>('library');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('movie');
  const [libraryResult, setLibraryResult] = useState<WatchWithLibraryResult | null>(null);
  const [watchlistResult, setWatchlistResult] = useState<WatchWithWatchlistResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [requested, setRequested] = useState(false);

  const { data: partners } = useQuery({
    queryKey: ['watchwith-partners'],
    queryFn: () => api<WatchWithPartner[]>('/api/watchwith/partners'),
  });

  const clearResults = () => {
    setLibraryResult(null);
    setWatchlistResult(null);
    setRequested(false);
    setError(null);
  };

  const spin = useMutation<
    { kind: 'library'; result: WatchWithLibraryResult } | { kind: 'watchlist'; result: WatchWithWatchlistResult },
    Error
  >({
    mutationFn: async () => {
      if (mode === 'library') {
        const result = await api<WatchWithLibraryResult>('/api/watchwith/library', {
          body: { partnerId, ...(typeFilter !== 'all' ? { type: typeFilter } : {}) },
        });
        return { kind: 'library', result };
      }
      const result = await api<WatchWithWatchlistResult>('/api/watchwith/watchlist', { body: { partnerId } });
      return { kind: 'watchlist', result };
    },
    onSuccess: (res) => {
      clearResults();
      if (res.kind === 'library') setLibraryResult(res.result);
      else setWatchlistResult(res.result);
    },
    onError: (err) => {
      clearResults();
      setError(err instanceof ApiError ? err.message : 'Something went wrong');
    },
  });

  const request = useMutation({
    mutationFn: (tmdbId: number) => api('/api/requests', { body: { tmdbId } }),
    onSuccess: () => setRequested(true),
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Request failed'),
  });

  const partner = partners?.find((p) => p.id === partnerId);
  const resultMedia = libraryResult?.pick ?? watchlistResult?.media ?? null;

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <div className="text-center">
        <h1 className="font-display text-2xl text-gold-300">Watch With</h1>
        <p className="mt-1 text-sm text-stone-400">Two people, one pick — no arguing.</p>
      </div>

      <div className="card space-y-4 p-5">
        <div className="space-y-1">
          <label className="text-xs font-semibold tracking-widest text-gold-500 uppercase">Watching with</label>
          <select
            className="input"
            value={partnerId ?? ''}
            onChange={(e) => {
              setPartnerId(e.target.value ? Number(e.target.value) : null);
              clearResults();
            }}
          >
            <option value="">Pick a partner…</option>
            {partners?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.username}
                {p.hasTrakt ? ' · Trakt' : p.hasPlex ? ' · Plex' : ''}
              </option>
            ))}
          </select>
          {partners && partners.length === 0 && (
            <p className="text-sm text-stone-500">No one else has an account here yet — share the app!</p>
          )}
        </div>

        <div className="flex justify-center gap-2">
          <button className={`btn ${mode === 'library' ? 'btn-gold' : 'btn-ghost'}`} onClick={() => { setMode('library'); clearResults(); }}>
            Neither has seen it
          </button>
          <button className={`btn ${mode === 'watchlist' ? 'btn-gold' : 'btn-ghost'}`} onClick={() => { setMode('watchlist'); clearResults(); }}>
            Both want to see it
          </button>
        </div>
        <p className="text-center text-xs text-stone-500">
          {mode === 'library'
            ? 'A random library title neither of you has watched.'
            : 'A random title from the overlap of your plex.tv watchlists (both of you need Plex sign-in).'}
        </p>

        {mode === 'library' && (
          <div className="flex justify-center gap-2">
            {(['movie', 'show', 'all'] as const).map((f) => (
              <button key={f} onClick={() => setTypeFilter(f)} className={`btn ${typeFilter === f ? 'btn-gold' : 'btn-ghost'}`}>
                {f === 'movie' ? 'Movies' : f === 'show' ? 'Shows' : 'Everything'}
              </button>
            ))}
          </div>
        )}

        <button
          className="btn btn-gold w-full text-base"
          disabled={!partnerId || spin.isPending}
          onClick={() => spin.mutate()}
        >
          {spin.isPending ? 'Consulting the marquee…' : '🎬 Pick for us'}
        </button>
        {error && <p className="text-center text-sm text-crimson-500">{error}</p>}
      </div>

      {libraryResult && (
        <p className="text-center text-xs text-stone-500">
          {libraryResult.poolSize} candidates neither of you has seen · your history via {methodLabel[libraryResult.myMethod]}, {partner?.username}
          ’s via {methodLabel[libraryResult.partnerMethod]}
        </p>
      )}
      {watchlistResult && (
        <p className="text-center text-xs text-stone-500">
          {watchlistResult.poolSize} title{watchlistResult.poolSize === 1 ? '' : 's'} on both watchlists
        </p>
      )}

      {resultMedia && (
        <div className="card overflow-hidden">
          <div className="mx-auto max-w-60 p-4">
            <Poster mediaId={resultMedia.id} title={resultMedia.title} className="rounded-lg" />
          </div>
          <div className="space-y-3 px-6 pb-6">
            <p className="marquee-title text-center text-2xl">{resultMedia.title}</p>
            <MediaFacts item={resultMedia} />
          </div>
        </div>
      )}

      {watchlistResult && !watchlistResult.media && (
        <div className="card space-y-3 p-6 text-center">
          <p className="marquee-title text-2xl">{watchlistResult.title}</p>
          <p className="text-sm text-stone-400">
            {watchlistResult.year ?? ''} · on both of your watchlists, but not in the library yet
          </p>
          {requested ? (
            <p className="text-sm text-gold-300">✓ Requested</p>
          ) : watchlistResult.requestsEnabled && watchlistResult.tmdbId ? (
            <button className="btn btn-gold mx-auto" disabled={request.isPending} onClick={() => request.mutate(watchlistResult.tmdbId!)}>
              Request it
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}
