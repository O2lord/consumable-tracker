import type { ReactNode } from "react";

/** The white card every dashboard chart sits in. */
export function ChartCard({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="min-w-0 rounded-xl border border-line bg-surface p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-[12.5px] font-semibold text-muted">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

/** Colour key under a chart. `color` is any CSS colour, normally a var(--chart-*) token. */
export function Legend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11.5px] text-muted">
      {items.map((i) => (
        <li key={i.label} className="flex items-center gap-1.5">
          <span aria-hidden className="inline-block size-2 rounded-[2px]" style={{ background: i.color }} />
          {i.label}
        </li>
      ))}
    </ul>
  );
}
