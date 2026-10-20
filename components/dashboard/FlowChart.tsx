import { dayLabel, type DayFlow } from "@/lib/dashboard";
import { ChartCard, Legend } from "./ChartCard";

const W = 330;
const H = 120;

/** Paired bars per day: issued next to returned. Pure SVG, so it renders on the server with no script. */
export function FlowChart({ flow, range, period }: { flow: DayFlow[]; range: number; period?: string }) {
  const max = Math.max(1, ...flow.flatMap((d) => [d.issued, d.returned]));
  const slot = W / flow.length;
  const barW = Math.max(2, Math.min(14, slot * 0.34));
  // Show about seven labels however long the range is.
  const labelEvery = Math.ceil(flow.length / 7);
  const totalIssued = flow.reduce((s, d) => s + d.issued, 0);
  const totalReturned = flow.reduce((s, d) => s + d.returned, 0);

  // "last 7 days" for a preset range, or the dates themselves for a custom one.
  const periodText = period ?? `last ${range} days`;

  return (
    <ChartCard title={`Issued vs returned, ${periodText}`}>
      <svg
        role="img"
        aria-label={`Issued ${totalIssued} and returned ${totalReturned} over ${period ?? `the last ${range} days`}`}
        viewBox={`0 0 ${W} ${H + 18}`}
        className="block h-auto w-full"
      >
        {flow.map((d, i) => {
          const x = i * slot + (slot - (barW * 2 + 3)) / 2;
          const issuedH = (d.issued / max) * H;
          const returnedH = (d.returned / max) * H;
          return (
            <g key={d.day}>
              <title>{`${d.day}: ${d.issued} issued, ${d.returned} returned`}</title>
              <rect x={x} y={H - issuedH} width={barW} height={issuedH} rx={3} fill="var(--chart-green)" />
              <rect x={x + barW + 3} y={H - returnedH} width={barW} height={returnedH} rx={3} fill="var(--chart-green-soft)" />
              {i % labelEvery === 0 ? (
                <text x={x + barW + 1.5} y={H + 14} textAnchor="middle" fontSize={10} fill="var(--muted)">
                  {dayLabel(d.day, range)}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
      <Legend
        items={[
          { label: `Issued ${totalIssued}`, color: "var(--chart-green)" },
          { label: `Returned ${totalReturned}`, color: "var(--chart-green-soft)" },
        ]}
      />
    </ChartCard>
  );
}
