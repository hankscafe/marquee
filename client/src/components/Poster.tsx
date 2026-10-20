import { useState } from 'react';

// `src` overrides the signed-in poster URL (the public poll page serves its own).
export function Poster({
  mediaId,
  title,
  src,
  className = '',
}: {
  mediaId: number | null;
  title: string;
  src?: string;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const url = src ?? (mediaId ? `/api/media/${mediaId}/poster` : null);
  if (!url || failed) {
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
      onError={() => setFailed(true)}
      className={`aspect-[2/3] w-full object-cover ${className}`}
    />
  );
}
