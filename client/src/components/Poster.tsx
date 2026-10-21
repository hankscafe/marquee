import { useState } from 'react';

// `src` overrides the signed-in poster URL (the public poll page serves its own).
// `width` asks the server for a bigger image than the grid-sized default.
export function Poster({
  mediaId,
  title,
  src,
  width,
  className = '',
}: {
  mediaId: number | null;
  title: string;
  src?: string;
  width?: number;
  className?: string;
}) {
  // Remember which image failed, not just that one did: the same card shows a
  // different title after each randomizer spin.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const url = src ?? (mediaId ? `/api/media/${mediaId}/poster${width ? `?w=${width}` : ''}` : null);
  if (!url || url === failedUrl) {
    return (
      <div className={`flex aspect-[2/3] items-center justify-center bg-ink-700 text-3xl ${className}`} aria-label={title}>
        🎬
      </div>
    );
  }
  return (
    <img
      src={url}
      alt={title}
      loading="lazy"
      onError={() => setFailedUrl(url)}
      className={`aspect-[2/3] w-full object-cover ${className}`}
    />
  );
}
