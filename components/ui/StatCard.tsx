// Number card used at the top of report pages: white, with a coloured left edge.
const EDGE = {
  brand: "border-l-brand",
  ok: "border-l-ok",
  warn: "border-l-warn",
  bad: "border-l-bad",
} as const;

export function StatCard({
  value,
  label,
  tone = "brand",
}: {
  value: React.ReactNode;
  label: string;
  tone?: keyof typeof EDGE;
}) {
  return (
    <div className={`rounded-xl border border-line border-l-4 bg-surface p-4 ${EDGE[tone]}`}>
      <p className="text-[28px] font-bold leading-tight tabular-nums">{value}</p>
      <p className="text-[13px] text-muted">{label}</p>
    </div>
  );
}
