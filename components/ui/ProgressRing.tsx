/**
 * A ring that fills as `value` approaches `total`, with the count in the middle.
 * Used on the receiving screen for "48 of 50 scanned".
 */
export function ProgressRing({ value, total, caption = "scanned" }: { value: number; total: number; caption?: string }) {
  const percent = total > 0 ? Math.min(100, Math.max(0, Math.round((value / total) * 100))) : 0;

  return (
    <div className="shrink-0">
      <div
        aria-hidden
        className="grid size-[132px] place-items-center rounded-full"
        style={{ background: `conic-gradient(var(--brand) ${percent}%, var(--line) 0)` }}
      >
        <div className="flex size-[104px] flex-col items-center justify-center rounded-full bg-surface text-center leading-tight">
          <b className="text-3xl font-bold tabular-nums">{value}</b>
          <span className="text-xs text-muted">
            of {total} {caption}
          </span>
        </div>
      </div>
      <p className="sr-only" aria-live="polite">
        {value} of {total} {caption}
      </p>
    </div>
  );
}
