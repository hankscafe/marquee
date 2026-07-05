import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { MediaItem, NowPlayingResponse } from '@marquee/shared';
import { api } from '../api';
import { Poster } from '../components/Poster';

function msToClock(ms: number): string {
  const totalMinutes = Math.max(0, Math.floor(ms / 60_000));
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}` : `0:${String(m).padStart(2, '0')}`;
}

// Fullscreen digital movie poster for a wall-mounted display: live playback
// with a progress bar when something is on; rotating library posters when idle.
export function PosterMode() {
  const navigate = useNavigate();
  const [now, setNow] = useState(Date.now());
  const [idleIndex, setIdleIndex] = useState(0);
  const [sessionIndex, setSessionIndex] = useState(0);
  const fetchedAtRef = useRef(Date.now());

  const { data } = useQuery({
    queryKey: ['nowplaying'],
    queryFn: () => api<NowPlayingResponse>('/api/nowplaying'),
    refetchInterval: 10_000,
  });
  const { data: idlePool, refetch: refetchIdle } = useQuery({
    queryKey: ['poster-idle'],
    queryFn: () => api<MediaItem[]>('/api/media?sort=random'),
    staleTime: Infinity,
  });

  useEffect(() => {
    fetchedAtRef.current = Date.now();
  }, [data]);

  // 1s tick so the progress bar moves between polls.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  // Idle poster rotation.
  useEffect(() => {
    const timer = setInterval(() => {
      setIdleIndex((i) => {
        if (!idlePool?.length) return 0;
        if (i + 1 >= idlePool.length) {
          refetchIdle();
          return 0;
        }
        return i + 1;
      });
    }, 25_000);
    return () => clearInterval(timer);
  }, [idlePool, refetchIdle]);

  const sessions = data?.sessions ?? [];

  // Carousel across simultaneous streams: auto-advance, keep the index valid
  // as streams start and stop.
  useEffect(() => {
    if (sessionIndex >= sessions.length && sessionIndex !== 0) setSessionIndex(0);
  }, [sessions.length, sessionIndex]);
  useEffect(() => {
    if (sessions.length < 2) return;
    const timer = setInterval(() => {
      setSessionIndex((i) => (i + 1) % sessions.length);
    }, 12_000);
    return () => clearInterval(timer);
  }, [sessions.length]);

  const session = sessions[sessionIndex] ?? sessions[0] ?? null;
  const idle = idlePool?.[idleIndex] ?? null;

  const elapsed = session
    ? Math.min(
        session.durationMs,
        session.progressMs + (session.state === 'playing' ? now - fetchedAtRef.current : 0),
      )
    : 0;
  const pct = session && session.durationMs > 0 ? (elapsed / session.durationMs) * 100 : 0;
  const endsAt = session
    ? new Date(now + Math.max(0, session.durationMs - elapsed)).toLocaleTimeString([], {
        hour: 'numeric',
        minute: '2-digit',
      })
    : null;

  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen().catch(() => {});
  };

  const mediaId = session ? session.mediaId : (idle?.id ?? null);
  const title = session ? session.title : (idle?.title ?? 'Marquee');

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-6 overflow-hidden bg-ink-950 px-6 py-8">
      {/* ambient glow behind the poster */}
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_50%_40%_at_50%_45%,rgba(62,203,255,0.10),transparent)]" />

      <div className="absolute top-4 right-4 flex gap-2">
        <button
          className="rounded-lg px-3 py-2 text-stone-500 opacity-50 transition-opacity hover:opacity-100"
          onClick={toggleFullscreen}
          title="Toggle fullscreen"
        >
          ⛶
        </button>
        <button
          className="rounded-lg px-3 py-2 text-stone-500 opacity-50 transition-opacity hover:opacity-100"
          onClick={() => navigate('/')}
          title="Exit poster mode"
        >
          ✕
        </button>
      </div>

      <p className="marquee-title text-2xl sm:text-3xl">
        {session ? '★ NOW PLAYING ★' : '★ NOW SHOWING ★'}
      </p>

      <div className="fade-in w-[min(48vh,85vw)]" key={`${session?.title ?? ''}-${mediaId ?? title}`}>
        <Poster
          mediaId={mediaId}
          title={title}
          className="rounded-xl shadow-[0_0_80px_rgba(62,203,255,0.15)]"
        />
      </div>

      <div className="max-w-2xl text-center">
        <p className="font-display text-3xl text-stone-100 sm:text-4xl">{title}</p>
        {session?.subtitle && <p className="mt-1 text-lg text-stone-400">{session.subtitle}</p>}
        <p className="mt-1 text-sm text-stone-500">
          {session ? (
            <>
              {session.year ?? ''}
              {session.user ? ` · for ${session.user}` : ''}
            </>
          ) : (
            <>
              {idle?.year ?? ''}
              {idle?.genres?.length ? ` · ${idle.genres.slice(0, 3).join(', ')}` : ''}
            </>
          )}
        </p>
      </div>

      {session && (
        <div className="w-full max-w-2xl space-y-2">
          <div className="h-2 overflow-hidden rounded-full bg-ink-700">
            <div className="h-full rounded-full bg-neon-400 transition-all duration-1000" style={{ width: `${pct}%` }} />
          </div>
          <div className="flex items-center justify-between text-sm text-stone-400">
            <span>{msToClock(elapsed)} / {msToClock(session.durationMs)}</span>
            {session.state === 'paused' ? (
              <span className="chip bg-crimson-500/20 text-crimson-500">PAUSED</span>
            ) : (
              <span>Ends {endsAt}</span>
            )}
          </div>
        </div>
      )}
      {sessions.length > 1 && (
        <div className="flex items-center gap-2.5">
          {sessions.map((s, i) => (
            <button
              key={`${s.source}-${s.title}-${i}`}
              onClick={() => setSessionIndex(i)}
              title={`${s.title}${s.user ? ` (${s.user})` : ''}`}
              aria-label={`Show stream ${i + 1} of ${sessions.length}`}
              className={`h-2.5 w-2.5 rounded-full transition-colors ${
                i === sessionIndex ? 'bg-neon-400' : 'bg-ink-700 hover:bg-neon-600'
              }`}
            />
          ))}
        </div>
      )}

      {!session && <p className="text-xs tracking-widest text-stone-600 uppercase">From the library</p>}
    </div>
  );
}
