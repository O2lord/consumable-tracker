// A ring that fills clockwise from the top as things are scanned, with the percentage in the middle.
// Used in the scan pop-ups (dispatch and receive). Radius 36 in an 88px box, so the ring is 2 * pi * 36 long.

const RING_RADIUS = 36;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

export function ProgressDonut({ done, total, label = "scanned" }: { done: number; total: number; label?: string }) {
  const ratio = total > 0 ? Math.min(1, done / total) : 0;
  const percent = Math.round(ratio * 100);
  return (
    <div className="relative h-[88px] w-[88px] shrink-0">
      <svg
        width="88"
        height="88"
        viewBox="0 0 88 88"
        role="img"
        aria-label={`${done} of ${total} ${label}, ${percent} percent`}
      >
        <circle cx="44" cy="44" r={RING_RADIUS} fill="none" stroke="currentColor" strokeWidth="10" className="text-line" />
        <circle
          cx="44"
          cy="44"
          r={RING_RADIUS}
          fill="none"
          stroke="currentColor"
          strokeWidth="10"
          strokeLinecap="round"
          strokeDasharray={`${ratio * RING_LENGTH} ${RING_LENGTH}`}
          transform="rotate(-90 44 44)"
          className="text-brand"
        />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center text-base font-bold">{percent}%</span>
    </div>
  );
}
