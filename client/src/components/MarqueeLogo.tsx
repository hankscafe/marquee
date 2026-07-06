/** Theater-marquee wordmark. Scales with the parent's font-size (set text-* on the wrapper). */
export function MarqueeLogo({ className = '' }: { className?: string }) {
  return (
    <span className={`marquee-sign ${className}`}>
      <span className="marquee-bulbs" aria-hidden="true" />
      <span className="marquee-sign-text">MARQUEE</span>
      <span className="marquee-bulbs marquee-bulbs-reverse" aria-hidden="true" />
    </span>
  );
}
