"use client";

import { useMemo, type ReactNode } from "react";
import type { LocationItemRow } from "@/server/services/dashboard.service";
import { scopeNoun, type ItemScope } from "@/lib/dashboard-prefs";
import { ChartCard } from "./ChartCard";

const SEGMENTS = [
  { key: "inStore", label: "In store", color: "var(--chart-green)" },
  { key: "issued", label: "Issued", color: "var(--chart-amber)" },
  { key: "returned", label: "Returned", color: "var(--chart-blue)" },
] as const;

/** Bulk items are used rather than issued and returned, so the amber segment is named for what it holds. */
const issuedLabel = (scope: ItemScope) => (scope === "bottles" ? "Issued" : scope === "bulk" ? "Used" : "Issued or used");

type Counts = Record<(typeof SEGMENTS)[number]["key"], number>;

const sumOf = (c: Counts) => c.inStore + c.issued + c.returned;

/**
 * Items per location as stacked bars (in store, issued or used, returned). Which items and which locations show is
 * chosen in the card's settings; every chosen location is listed, including one with nothing in it.
 */
export function LocationBreakdown({
  rows,
  locationNames,
  scope = "bottles",
  settings,
}: {
  rows: LocationItemRow[];
  locationNames: string[];
  scope?: ItemScope;
  settings?: ReactNode;
}) {
  const locations = useMemo(() => {
    const byName = new Map<string, Counts>(locationNames.map((name) => [name, { inStore: 0, issued: 0, returned: 0 }]));
    for (const r of rows) {
      const entry = byName.get(r.locationName) ?? { inStore: 0, issued: 0, returned: 0 };
      entry.inStore += r.inStore;
      entry.issued += r.issued;
      entry.returned += r.returned;
      byName.set(r.locationName, entry);
    }
    return [...byName.entries()].map(([name, counts]) => ({ name, counts })).sort((a, b) => a.name.localeCompare(b.name));
  }, [rows, locationNames]);

  const totals = locations.reduce<Counts>(
    (t, l) => ({ inStore: t.inStore + l.counts.inStore, issued: t.issued + l.counts.issued, returned: t.returned + l.counts.returned }),
    { inStore: 0, issued: 0, returned: 0 },
  );
  const max = Math.max(1, ...locations.map((l) => sumOf(l.counts)));

  return (
    <ChartCard title={`${scopeNoun(scope)} per location`} action={settings}>
      {locations.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted">No locations are chosen. Use the settings to pick some.</p>
      ) : (
        <div>
          {locations.map((l) => {
            const total = sumOf(l.counts);
            return (
              <div key={l.name} className="border-t border-line py-2.5">
                <div className="mb-1.5 flex justify-between font-semibold">
                  <span>{l.name}</span>
                  <span className="tabular-nums">{total}</span>
                </div>
                <div style={{ width: `${(total / max) * 100}%` }}>
                  <div className="flex h-3 gap-0.5">
                    {SEGMENTS.filter((s) => l.counts[s.key] > 0).map((s) => {
                      const label = s.key === "issued" ? issuedLabel(scope) : s.label;
                      return (
                      <span
                        key={s.key}
                        tabIndex={0}
                        aria-label={`${label} ${l.counts[s.key]}`}
                        className="group/seg relative min-w-1 rounded-[3px] outline-none transition-transform hover:scale-y-125 focus:scale-y-125"
                        style={{ flex: l.counts[s.key], background: s.color }}
                      >
                        <span
                          aria-hidden
                          className="pointer-events-none absolute bottom-[calc(100%+6px)] left-1/2 z-10 hidden -translate-x-1/2 rounded-md bg-ink px-2 py-0.5 text-xs font-semibold whitespace-nowrap text-white group-hover/seg:block group-focus/seg:block"
                        >
                          {l.counts[s.key]}
                        </span>
                      </span>
                      );
                    })}
                  </div>
                </div>
              </div>
            );
          })}

          <div className="border-t border-line pt-2.5">
            <div className="mb-2 flex justify-between font-semibold">
              <span>Total</span>
              <span className="tabular-nums">{sumOf(totals)}</span>
            </div>
            <div className="grid grid-cols-3 gap-2">
              {SEGMENTS.map((s) => (
                <div key={s.key} className="rounded-lg bg-page px-2.5 py-2">
                  <span className="flex items-center gap-1.5 text-xs text-muted">
                    <i aria-hidden className="inline-block size-2 rounded-[2px]" style={{ background: s.color }} />
                    {s.key === "issued" ? issuedLabel(scope) : s.label}
                  </span>
                  <b className="block text-xl tabular-nums">{totals[s.key]}</b>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </ChartCard>
  );
}
