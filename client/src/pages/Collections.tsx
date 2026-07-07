import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CollectionDetail,
  CollectionProgress,
  FranchiseDetail,
  FranchisesResponse,
  MediaItem,
  TraktDeviceStart,
  TraktStatus,
} from '@marquee/shared';
import { api, ApiError } from '../api';
import { useAuth } from '../auth';
import { MediaFacts } from '../components/MediaDetails';
import { Modal } from '../components/Modal';
import { Poster } from '../components/Poster';

function Franchises() {
  const { data: auth } = useAuth();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [requested, setRequested] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState<string | null>(null);

  const { data } = useQuery({ queryKey: ['franchises'], queryFn: () => api<FranchisesResponse>('/api/franchises') });
  const { data: detail } = useQuery({
    queryKey: ['franchises', selectedId],
    queryFn: () => api<FranchiseDetail>(`/api/franchises/${selectedId}`),
    enabled: selectedId !== null,
  });

  const requestTitle = useMutation({
    mutationFn: (tmdbId: string) => api('/api/requests', { body: { tmdbId: Number(tmdbId) } }),
    onSuccess: (_res, tmdbId) => {
      setRequested((prev) => new Set(prev).add(tmdbId));
      setMessage('✓ Request sent');
    },
    onError: (err) => setMessage(err instanceof ApiError ? `✗ ${err.message}` : '✗ Request failed'),
  });

  if (!data) return null;

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-xs font-semibold tracking-widest text-neon-500 uppercase">Film series (TMDb)</h2>
        <p className="mt-1 text-sm text-stone-400">
          Series your library has started — and what's missing to complete them.
        </p>
      </div>

      {data.franchises.length === 0 && (
        <p className="text-sm text-stone-500">
          {auth?.user?.isAdmin
            ? 'No series data yet — add a TMDb API key and run the franchise scan from the Admin page.'
            : 'No series data yet — ask your admin to run the franchise scan.'}
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3">
        {data.franchises.map((f) => {
          const pct = f.total > 0 ? Math.round((f.owned / f.total) * 100) : 0;
          return (
            <button
              key={f.id}
              onClick={() => {
                setSelectedId(f.id);
                setMessage(null);
              }}
              className="card p-4 text-left transition-colors hover:border-neon-400/50"
            >
              <div className="flex items-start justify-between gap-2">
                <p className="font-display text-lg text-stone-100">{f.name}</p>
                {f.missing > 0 && <span className="chip bg-crimson-500/20 text-crimson-500">{f.missing} missing</span>}
              </div>
              <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-ink-700">
                <div className="h-full rounded-full bg-neon-400" style={{ width: `${pct}%` }} />
              </div>
              <p className="mt-2 text-xs text-stone-400">
                {f.owned}/{f.total} in library
              </p>
            </button>
          );
        })}
      </div>

      {selectedId !== null && (
        <Modal wide onClose={() => setSelectedId(null)}>
          {detail ? (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h3 className="font-display text-xl text-stone-100">{detail.name}</h3>
                <button className="btn btn-ghost" onClick={() => setSelectedId(null)}>
                  Close
                </button>
              </div>
              {message && <p className="text-sm text-stone-300">{message}</p>}
              <div className="grid grid-cols-3 gap-3 sm:grid-cols-5 md:grid-cols-6">
                {detail.parts.map((p) => (
              <div key={p.tmdbMovieId} className={p.inLibrary ? '' : 'opacity-90'}>
                {p.inLibrary && p.mediaId ? (
                  <Poster mediaId={p.mediaId} title={p.title} className="rounded-lg" />
                ) : p.posterPath ? (
                  <img
                    src={`https://image.tmdb.org/t/p/w342${p.posterPath}`}
                    alt={p.title}
                    loading="lazy"
                    className="aspect-[2/3] w-full rounded-lg object-cover ring-1 ring-crimson-500/50"
                  />
                ) : (
                  <div className="flex aspect-[2/3] items-center justify-center rounded-lg bg-ink-700 text-3xl ring-1 ring-crimson-500/50">
                    🎬
                  </div>
                )}
                <p className="mt-1 truncate text-xs text-stone-300">
                  {p.title} {p.year ? `(${p.year})` : ''}
                </p>
                {p.inLibrary ? (
                  <p className="text-xs text-neon-500">In library</p>
                ) : requested.has(p.tmdbMovieId) ? (
                  <p className="text-xs text-neon-300">✓ Requested</p>
                ) : detail.requestsEnabled ? (
                  <button
                    className="mt-1 w-full rounded-md border border-neon-500/25 px-2 py-1 text-xs text-neon-300 hover:bg-neon-500/10"
                    disabled={requestTitle.isPending}
                    onClick={() => requestTitle.mutate(p.tmdbMovieId)}
                  >
                    Request
                  </button>
                ) : (
                  <p className="text-xs text-stone-500">Missing</p>
                )}
              </div>
                ))}
              </div>
            </div>
          ) : (
            <p className="text-stone-400">Loading…</p>
          )}
        </Modal>
      )}
    </section>
  );
}

function TraktCard() {
  const { data: auth } = useAuth();
  const queryClient = useQueryClient();
  const [device, setDevice] = useState<TraktDeviceStart | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const { data: status } = useQuery({ queryKey: ['trakt'], queryFn: () => api<TraktStatus>('/api/trakt/status') });

  // Poll Trakt until the user enters the code at trakt.tv/activate.
  useEffect(() => {
    if (!device) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (cancelled) return;
      try {
        const res = await api<{ pending?: boolean; watchedCount?: number }>('/api/trakt/poll', {
          body: { deviceCode: device.deviceCode },
        });
        if (cancelled) return;
        if (!res.pending) {
          setDevice(null);
          setMessage(`✓ Trakt connected — matched ${res.watchedCount ?? 0} watched titles in your library`);
          queryClient.invalidateQueries({ queryKey: ['trakt'] });
          queryClient.invalidateQueries({ queryKey: ['collections'] });
          return;
        }
      } catch (err) {
        if (cancelled) return;
        setDevice(null);
        setError(err instanceof ApiError ? err.message : 'Trakt connection failed');
        return;
      }
      timer = setTimeout(tick, (device.interval || 5) * 1000);
    };
    timer = setTimeout(tick, (device.interval || 5) * 1000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [device, queryClient]);

  const connect = useMutation({
    mutationFn: () => api<TraktDeviceStart>('/api/trakt/connect', { body: {} }),
    onSuccess: (res) => {
      setError(null);
      setMessage(null);
      setDevice(res);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Could not reach Trakt'),
  });

  const refresh = useMutation({
    mutationFn: () => api<{ watchedCount: number }>('/api/trakt/refresh', { body: {} }),
    onSuccess: (res) => {
      setMessage(`✓ Refreshed — ${res.watchedCount} watched titles matched`);
      queryClient.invalidateQueries({ queryKey: ['trakt'] });
      queryClient.invalidateQueries({ queryKey: ['collections'] });
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Refresh failed'),
  });

  const disconnect = useMutation({
    mutationFn: () => api('/api/trakt/disconnect', { method: 'POST', body: {} }),
    onSuccess: () => {
      setMessage('Trakt disconnected');
      queryClient.invalidateQueries({ queryKey: ['trakt'] });
      queryClient.invalidateQueries({ queryKey: ['collections'] });
    },
  });

  if (!status) return null;

  return (
    <div className="card space-y-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xs font-semibold tracking-widest text-neon-500 uppercase">Trakt</h2>
          <p className="mt-1 text-sm text-stone-400">
            {status.connected
              ? `Connected — ${status.watchedCount} watched titles matched. Watch status here and in the randomizer is yours, not the server account's.`
              : 'Connect your Trakt account for personal watch status in collections and the randomizer.'}
          </p>
        </div>
        <div className="flex gap-2">
          {!status.connected && status.configured && (
            <button className="btn btn-neon" onClick={() => connect.mutate()} disabled={connect.isPending || !!device}>
              Connect Trakt
            </button>
          )}
          {status.connected && (
            <>
              <button className="btn btn-ghost" onClick={() => refresh.mutate()} disabled={refresh.isPending}>
                {refresh.isPending ? 'Refreshing…' : 'Refresh'}
              </button>
              <button className="btn btn-ghost" onClick={() => disconnect.mutate()}>
                Disconnect
              </button>
            </>
          )}
        </div>
      </div>
      {!status.configured && (
        <p className="text-sm text-stone-500">
          {auth?.user?.isAdmin
            ? 'Add your Trakt API app credentials under Admin → Trakt to enable this.'
            : 'Trakt is not set up on this server yet — ask your admin.'}
        </p>
      )}
      {device && (
        <div className="rounded-lg border border-neon-500/20 bg-ink-950/60 p-4 text-center">
          <p className="text-sm text-stone-300">
            Go to{' '}
            <a href={device.verificationUrl} target="_blank" rel="noreferrer" className="text-neon-300 underline">
              {device.verificationUrl}
            </a>{' '}
            and enter:
          </p>
          <p className="font-display mt-2 text-3xl tracking-[0.3em] text-neon-300">{device.userCode}</p>
          <button className="mt-3 text-sm text-stone-400 hover:text-neon-300" onClick={() => setDevice(null)}>
            Cancel
          </button>
        </div>
      )}
      {message && <p className="text-sm text-stone-300">{message}</p>}
      {error && <p className="text-sm text-crimson-500">{error}</p>}
    </div>
  );
}

export function Collections() {
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [pick, setPick] = useState<MediaItem | null>(null);
  const [spinError, setSpinError] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  const { data: collections, isLoading } = useQuery({
    queryKey: ['collections'],
    queryFn: () => api<CollectionProgress[]>('/api/collections'),
  });
  const { data: detail } = useQuery({
    queryKey: ['collections', selectedId],
    queryFn: () => api<CollectionDetail>(`/api/collections/${selectedId}`),
    enabled: selectedId !== null,
  });

  const spinUnwatched = useMutation({
    mutationFn: (collectionId: number) =>
      api<MediaItem>('/api/media/random', { body: { collectionId, unwatchedOnly: true } }),
    onSuccess: (item) => {
      setSpinError(null);
      setPick(item);
    },
    onError: (err) => {
      setPick(null);
      setSpinError(err instanceof ApiError ? err.message : 'Something went wrong');
    },
  });

  const filtered = (collections ?? []).filter((c) => c.title.toLowerCase().includes(query.trim().toLowerCase()));

  return (
    <div className="space-y-6">
      <h1 className="font-display text-2xl text-neon-300">Collections</h1>
      <TraktCard />

      {isLoading && <p className="text-stone-400">Loading…</p>}
      {collections && collections.length === 0 && (
        <div className="card p-8 text-center">
          <p className="font-display text-xl text-stone-300">No collections synced</p>
          <p className="mt-2 text-sm text-stone-400">
            Collections come from Plex — create some there, then run a library sync from the Admin page.
          </p>
        </div>
      )}

      {collections && collections.length > 0 && (
        <input
          className="input"
          placeholder={`Search ${collections.length} collections…`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      )}

      <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3">
        {filtered.map((c) => {
          const pct = c.itemCount > 0 ? Math.round((c.watchedCount / c.itemCount) * 100) : 0;
          return (
            <button
              key={c.id}
              onClick={() => {
                setSelectedId(c.id);
                setPick(null);
                setSpinError(null);
              }}
              className="card p-4 text-left transition-colors hover:border-neon-400/50"
            >
              <p className="font-display text-lg text-stone-100">{c.title}</p>
              <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-ink-700">
                <div className="h-full rounded-full bg-neon-400" style={{ width: `${pct}%` }} />
              </div>
              <p className="mt-2 text-xs text-stone-400">
                {c.watchedCount}/{c.itemCount} watched
                {c.librarySection ? ` · ${c.librarySection}` : ''}
              </p>
            </button>
          );
        })}
      </div>
      {collections && collections.length > 0 && filtered.length === 0 && (
        <p className="text-sm text-stone-400">No collections match “{query}”.</p>
      )}

      {selectedId !== null && (
        <Modal wide onClose={() => setSelectedId(null)}>
          {detail ? (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="font-display text-xl text-stone-100">{detail.title}</h2>
                <div className="flex gap-2">
                  <button
                    className="btn btn-neon"
                    disabled={spinUnwatched.isPending}
                    onClick={() => spinUnwatched.mutate(detail.id)}
                  >
                    Spin an unwatched one
                  </button>
                  <button className="btn btn-ghost" onClick={() => setSelectedId(null)}>
                    Close
                  </button>
                </div>
              </div>
              {spinError && <p className="text-sm text-crimson-500">{spinError}</p>}
              {pick && (
                <div className="flex flex-col gap-4 rounded-lg border border-neon-400/40 bg-ink-950/50 p-4 sm:flex-row">
                  <div className="mx-auto w-32 shrink-0 sm:mx-0">
                    <Poster mediaId={pick.id} title={pick.title} className="rounded-lg" />
                  </div>
                  <div className="min-w-0 flex-1 space-y-2">
                    <p className="marquee-title text-xl">{pick.title}</p>
                    <MediaFacts item={pick} />
                  </div>
                </div>
              )}
              <div className="grid grid-cols-3 gap-3 sm:grid-cols-5 md:grid-cols-6">
                {detail.items.map((m) => (
                  <div key={m.id} className={m.watchedByMe ? 'opacity-45' : ''} title={m.watchedByMe ? 'Watched' : 'Not watched yet'}>
                    <div className="relative">
                      <Poster mediaId={m.id} title={m.title} className="rounded-lg" />
                      {m.watchedByMe && (
                        <span className="absolute top-1.5 right-1.5 rounded-full bg-ink-950/85 px-1.5 py-0.5 text-xs text-neon-300">
                          ✓
                        </span>
                      )}
                    </div>
                    <p className="mt-1 truncate text-xs text-stone-300">
                      {m.title} {m.year ? `(${m.year})` : ''}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <p className="text-stone-400">Loading…</p>
          )}
        </Modal>
      )}

      <Franchises />
    </div>
  );
}
