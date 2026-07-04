import { useQuery } from '@tanstack/react-query';
import type { MediaItem } from '@marquee/shared';
import { api } from '../api';
import { Poster } from './Poster';

export function MediaFacts({ item }: { item: MediaItem }) {
  return (
    <div className="space-y-2 text-left">
      <div className="flex flex-wrap items-center gap-2 text-sm text-stone-400">
        {item.year && <span>{item.year}</span>}
        {item.durationMs != null && item.durationMs > 0 && <span>· {Math.round(item.durationMs / 60000)} min</span>}
        {item.contentRating && <span className="chip border border-stone-500/40 text-stone-300">{item.contentRating}</span>}
        {item.rating != null && <span className="text-gold-300">★ {item.rating.toFixed(1)}</span>}
        {item.watched && <span className="chip bg-gold-500/15 text-gold-300">Watched</span>}
      </div>
      {item.genres && item.genres.length > 0 && (
        <p className="text-sm text-stone-400">{item.genres.join(' · ')}</p>
      )}
      {item.summary && <p className="text-sm text-stone-300">{item.summary}</p>}
      {item.directors && item.directors.length > 0 && (
        <p className="text-sm text-stone-400">
          <span className="text-stone-500">Directed by</span> {item.directors.join(', ')}
        </p>
      )}
      {item.actors && item.actors.length > 0 && (
        <p className="text-sm text-stone-400">
          <span className="text-stone-500">Starring</span> {item.actors.slice(0, 8).join(', ')}
        </p>
      )}
      <div className="flex flex-wrap gap-2 pt-2">
        {item.watchUrl && (
          <a href={item.watchUrl} target="_blank" rel="noreferrer" className="btn btn-gold">
            ▶ Watch on {item.source === 'plex' ? 'Plex' : item.source === 'jellyfin' ? 'Jellyfin' : 'Emby'}
          </a>
        )}
        <a
          href={`https://www.youtube.com/results?search_query=${encodeURIComponent(
            `${item.title}${item.year ? ` ${item.year}` : ''} trailer`,
          )}`}
          target="_blank"
          rel="noreferrer"
          className="btn btn-ghost"
        >
          🎞 Trailer
        </a>
      </div>
    </div>
  );
}

// Modal with full metadata for a title — used so voters can read up before choosing.
export function MediaDetailsModal({ mediaId, onClose }: { mediaId: number | null; onClose: () => void }) {
  const { data: item } = useQuery({
    queryKey: ['media-detail', mediaId],
    queryFn: () => api<MediaItem>(`/api/media/${mediaId}`),
    enabled: mediaId !== null,
  });

  if (mediaId === null) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4" onClick={onClose}>
      <div
        className="card max-h-[85vh] w-full max-w-md overflow-y-auto p-5"
        onClick={(e) => e.stopPropagation()}
      >
        {item ? (
          <div className="space-y-4">
            <div className="flex gap-4">
              <div className="w-28 shrink-0">
                <Poster mediaId={item.id} title={item.title} className="rounded-lg" />
              </div>
              <h2 className="font-display text-xl text-gold-300">{item.title}</h2>
            </div>
            <MediaFacts item={item} />
          </div>
        ) : (
          <p className="text-stone-400">Loading…</p>
        )}
        <button className="btn btn-ghost mt-5 w-full" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}
