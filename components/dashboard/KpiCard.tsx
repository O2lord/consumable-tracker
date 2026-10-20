import Link from "next/link";

type Tone = "bad" | "warn" | "ok" | null;

// Stat card: white, with a coloured left edge. Brand green by default, status colour when it needs a look.
const EDGE: Record<Exclude<Tone, null> | "brand", string> = {
  bad: "border-l-bad",
  warn: "border-l-warn",
  ok: "border-l-ok",
  brand: "border-l-brand",
};

export function ProgressBar({ percent, className = "" }: { percent: number; className?: string }) {
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      className={`h-2 overflow-hidden rounded-full bg-track ${className}`}
    >
      <i className="block h-full rounded-full bg-chart-green" style={{ width: `${percent}%` }} />
    </div>
  );
}

export function KpiCard({
  title,
  value,
  hint,
  tone = null,
  progress,
  href,
  linkLabel,
}: {
  title: string;
  value: number;
  hint: string;
  tone?: Tone;
  /** Percent filled and what it means, e.g. { percent: 58, label: "58% received" }. Left out when there is nothing to measure. */
  progress?: { percent: number; label: string } | null;
  href?: string;
  linkLabel?: string;
}) {
  return (
    // Each card spans five rows of the dashboard grid and shares them (subgrid), so the title, figure, description,
    // progress bar and link line up across cards however long a description is or whether a card has a bar or link.
    <section
      className={`mb-3 row-span-5 grid min-w-0 grid-rows-subgrid rounded-xl border border-l-4 border-line bg-surface p-4 ${EDGE[tone ?? "brand"]}`}
    >
      <h2 className="row-start-1 text-[12.5px] font-semibold text-muted">{title}</h2>
      <p className="row-start-2 mt-1 text-3xl leading-none font-bold tabular-nums">{value}</p>
      <p className="row-start-3 mt-2 text-xs text-muted">{hint}</p>
      {progress ? (
        <div className="row-start-4 mt-2">
          <ProgressBar percent={progress.percent} />
          <p className="mt-1 text-xs text-muted">{progress.label}</p>
        </div>
      ) : null}
      {href && linkLabel ? (
        <Link href={href} className="row-start-5 mt-2 self-start justify-self-start text-xs font-medium text-brand underline">
          {linkLabel}
        </Link>
      ) : null}
    </section>
  );
}
