import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { media } from '../db/schema.js';
import { requireUser } from '../auth/plugin.js';
import { fetchJfSessions, getJfConfig, type JfKind } from '../jellyfin/client.js';
import { getSessions } from '../plex/client.js';
import { getPlexConfig } from '../settings.js';
import type { SourceKind } from '../sources/types.js';

interface Session {
  source: SourceKind;
  title: string;
  subtitle: string | null;
  year: number | null;
  mediaId: number | null;
  state: 'playing' | 'paused';
  progressMs: number;
  durationMs: number;
  user: string | null;
}

function findMediaId(source: SourceKind, ratingKey: string | undefined): number | null {
  if (!ratingKey) return null;
  const row = db
    .select({ id: media.id })
    .from(media)
    .where(and(eq(media.source, source), eq(media.ratingKey, ratingKey)))
    .get();
  return row?.id ?? null;
}

async function plexSessions(): Promise<Session[]> {
  const cfg = getPlexConfig();
  if (!cfg) return [];
  return (await getSessions(cfg.url, cfg.token))
    .filter((s) => s.type === 'movie' || s.type === 'episode')
    .map((s) => {
      const isEpisode = s.type === 'episode';
      return {
        source: 'plex',
        title: isEpisode ? (s.grandparentTitle ?? s.title) : s.title,
        subtitle: isEpisode ? `S${s.parentIndex ?? '?'} · E${s.index ?? '?'} — ${s.title}` : null,
        year: s.year ?? null,
        mediaId: findMediaId('plex', isEpisode ? s.grandparentRatingKey : s.ratingKey),
        state: s.Player?.state === 'paused' ? 'paused' : 'playing',
        progressMs: s.viewOffset ?? 0,
        durationMs: s.duration ?? 0,
        user: s.User?.title ?? null,
      };
    });
}

async function jfSessions(kind: JfKind): Promise<Session[]> {
  if (!getJfConfig(kind)) return [];
  return (await fetchJfSessions(kind)).flatMap((s) => {
    const item = s.NowPlayingItem;
    if (!item || (item.Type !== 'Movie' && item.Type !== 'Episode')) return [];
    const isEpisode = item.Type === 'Episode';
    return {
      source: kind,
      title: isEpisode ? (item.SeriesName ?? item.Name) : item.Name,
      subtitle: isEpisode ? `S${item.ParentIndexNumber ?? '?'} · E${item.IndexNumber ?? '?'} — ${item.Name}` : null,
      year: item.ProductionYear ?? null,
      mediaId: findMediaId(kind, isEpisode ? item.SeriesId : item.Id),
      state: s.PlayState?.IsPaused ? 'paused' : 'playing',
      progressMs: Math.round((s.PlayState?.PositionTicks ?? 0) / 10_000),
      durationMs: Math.round((item.RunTimeTicks ?? 0) / 10_000),
      user: s.UserName ?? null,
    } satisfies Session;
  });
}

export async function nowPlayingRoutes(app: FastifyInstance) {
  // Active playback sessions across every configured media server, asked all at
  // once. A server that's down or slow is skipped — the poster display must never break.
  app.get('/api/nowplaying', { preHandler: requireUser }, async () => {
    const results = await Promise.allSettled([plexSessions(), jfSessions('jellyfin'), jfSessions('emby')]);
    return { sessions: results.flatMap((r) => (r.status === 'fulfilled' ? r.value : [])) };
  });
}
