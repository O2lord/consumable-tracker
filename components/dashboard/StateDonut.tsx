import type { ReactNode } from "react";
import type { BottlesByState } from "@/server/services/dashboard.service";
import { scopeNoun, type ItemScope } from "@/lib/dashboard-prefs";
import { ChartCard, Legend } from "./ChartCard";

const R = 40;
const C = 2 * Math.PI * R;

/** Where every item is in its life, as one ring. Bottles have four states; bulk items are on the shelf or used. */
export function StateDonut({ states, scope = "bottles", settings }: { states: BottlesByState; scope?: ItemScope; settings?: ReactNode }) {
  const slices = [
    { label: "In store", value: states.inStore, color: "var(--chart-green)" },
    { label: "Issued", value: states.issued, color: "var(--chart-amber)" },
    // Bulk items that were issued or used for a test.
    ...(states.used > 0 ? [{ label: "Used", value: states.used, color: "#c27a12" }] : []),
    { label: "Returned", value: states.returned, color: "var(--chart-blue)" },
    { label: "Voided", value: states.voided, color: "var(--chart-red)" },
    // Only shown when something is on a truck, so the usual view matches the four-state design.
    ...(states.inTransit > 0 ? [{ label: "In transit", value: states.inTransit, color: "var(--muted)" }] : []),
  ];
  const total = slices.reduce((s, x) => s + x.value, 0);

  let offset = 0;
  return (
    <ChartCard title={`${scopeNoun(scope)} by state`} action={settings}>
      <div className="flex flex-wrap items-center gap-4">
        <svg
          role="img"
          aria-label={`${total} ${scope === "bottles" ? "bottles" : "items"}: ${slices.map((s) => `${s.value} ${s.label.toLowerCase()}`).join(", ")}`}
          viewBox="0 0 100 100"
          className="block size-[130px] shrink-0"
        >
          <circle cx={50} cy={50} r={R} fill="none" stroke="var(--track)" strokeWidth={14} />
          {total > 0
            ? slices
                .filter((s) => s.value > 0)
                .map((s) => {
                  const len = (s.value / total) * C;
                  const el = (
                    <circle
                      key={s.label}
                      cx={50}
                      cy={50}
                      r={R}
                      fill="none"
                      stroke={s.color}
                      strokeWidth={14}
                      strokeDasharray={`${len} ${C - len}`}
                      strokeDashoffset={-offset}
                      transform="rotate(-90 50 50)"
                    />
                  );
                  offset += len;
                  return el;
                })
            : null}
          <text x={50} y={55} textAnchor="middle" fontSize={15} fontWeight={700} fill="var(--ink)">
            {total}
          </text>
        </svg>
        <div className="min-w-[110px] flex-1">
          <Legend items={slices.map((s) => ({ label: `${s.label} ${s.value}`, color: s.color }))} />
        </div>
      </div>
    </ChartCard>
  );
}
