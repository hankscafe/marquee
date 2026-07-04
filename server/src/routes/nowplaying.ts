import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { media } from '../db/schema.js';
import { requireUser } from '../auth/plugin.js';
import { fetchJfSessions, getJfConfig } from '../jellyfin/client.js';
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

export async function nowPlayingRoutes(app: FastifyInstance) {
  // Active playback sessions across every configured media server.
  // A source failing is silently skipped — the poster display must never break.
  app.get('/api/nowplaying', { preHandler: requireUser }, async () => {
    const sessions: Session[] = [];

    const plexCfg = getPlexConfig();
    if (plexCfg) {
      try {
        for (const s of await getSessions(plexCfg.url, plexCfg.token)) {
          if (s.type !== 'movie' && s.type !== 'episode') continue;
          const isEpisode = s.type === 'episode';
          sessions.push({
            source: 'plex',
            title: isEpisode ? (s.grandparentTitle ?? s.title) : s.title,
            subtitle: isEpisode ? `S${s.parentIndex ?? '?'} · E${s.index ?? '?'} — ${s.title}` : null,
            year: s.year ?? null,
            mediaId: findMediaId('plex', isEpisode ? s.grandparentRatingKey : s.ratingKey),
            state: s.Player?.state === 'paused' ? 'paused' : 'playing',
            progressMs: s.viewOffset ?? 0,
            durationMs: s.duration ?? 0,
            user: s.User?.title ?? null,
          });
        }
      } catch {
        // Plex unreachable — show idle mode instead
      }
    }

    for (const kind of ['jellyfin', 'emby'] as const) {
      if (!getJfConfig(kind)) continue;
      try {
        for (const s of await fetchJfSessions(kind)) {
          const item = s.NowPlayingItem;
          if (!item || (item.Type !== 'Movie' && item.Type !== 'Episode')) continue;
          const isEpisode = item.Type === 'Episode';
          sessions.push({
            source: kind,
            title: isEpisode ? (item.SeriesName ?? item.Name) : item.Name,
            subtitle: isEpisode ? `S${item.ParentIndexNumber ?? '?'} · E${item.IndexNumber ?? '?'} — ${item.Name}` : null,
            year: item.ProductionYear ?? null,
            mediaId: findMediaId(kind, isEpisode ? item.SeriesId : item.Id),
            state: s.PlayState?.IsPaused ? 'paused' : 'playing',
            progressMs: Math.round((s.PlayState?.PositionTicks ?? 0) / 10_000),
            durationMs: Math.round((item.RunTimeTicks ?? 0) / 10_000),
            user: s.UserName ?? null,
          });
        }
      } catch {
        // source unreachable — skip
      }
    }

    return { sessions };
  });
}
