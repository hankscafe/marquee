import { useState } from 'react';

export function Poster({ mediaId, title, className = '' }: { mediaId: number | null; title: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  if (!mediaId || failed) {
    return (
      <div className={`flex aspect-[2/3] items-center justify-center bg-ink-700 text-3xl ${className}`} aria-label={title}>
        🎬
      </div>
    );
  }
  return (
    <img
      src={`/api/media/${mediaId}/poster`}
      alt={title}
      loading="lazy"
      onError={() => setFailed(true)}
      className={`aspect-[2/3] w-full object-cover ${className}`}
    />
  );
}
