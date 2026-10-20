"use client";

import { useState, type ReactNode } from "react";
import { Dropdown } from "@/components/ui/Dropdown";
import { levelTone, type LevelTone } from "@/lib/dashboard";
import { pieceEquivalent } from "@/lib/pack-size";
import type { ItemScope, QuantityUnit } from "@/lib/dashboard-prefs";
import type { DashboardInsights } from "@/server/services/dashboard.service";

const R = 40;
const C = 2 * Math.PI * R;
const ALL = "all";

/**
 * "40 on hand, reorder at 10" in packs, or "4,000 pieces on hand, reorder at 1,000 pieces" in pieces. Only items counted
 * in packs change; everything else reads as it is.
 */
function stockText(
  i: { onHand: number; reorderLevel: number; unit: string; packSize: number; packSizeConfirmed: boolean },
  unit: QuantityUnit,
): string {
  const onHandPieces = pieceEquivalent(i.onHand, i.unit, i.packSize);
  const reorderPieces = pieceEquivalent(i.reorderLevel, i.unit, i.packSize);
  if (onHandPieces === null || reorderPieces === null) return `${i.onHand} on hand, reorder at ${i.reorderLevel}`;
  const note = i.packSizeConfirmed ? "" : ", pack size unconfirmed";
  if (unit === "pieces") {
    return `${onHandPieces.toLocaleString("en-GB")} pieces on hand (${i.onHand} packs${note}), reorder at ${reorderPieces.toLocaleString("en-GB")} pieces`;
  }
  return `${i.onHand} packs on hand (${onHandPieces.toLocaleString("en-GB")} pieces${note}), reorder at ${i.reorderLevel} packs`;
}

// Lighter than the page's status colours so they stay readable on the dark green card.
const TONE: Record<LevelTone, string> = { bad: "#ff8a73", warn: "#f2c14e", ok: "#9fe0b8" };

/**
 * Dark hero card: share of items at or above reorder level, plus one bar per item. It can be read for
 * every location together or for one location on its own, because a full store hides a lab that has run out.
 */
export function StockHealthCard({
  health,
  scope = "bottles",
  unit = "pieces",
  settings,
}: {
  health: DashboardInsights["health"];
  scope?: ItemScope;
  unit?: QuantityUnit;
  settings?: ReactNode;
}) {
  const [where, setWhere] = useState(ALL);
  const location = health.byLocation.find((l) => l.locationId === where);
  const view = location ?? health;
  const { items, belowReorder, healthyPercent, inStore } = view;
  const percent = healthyPercent ?? 0;

  const options = [
    { value: ALL, label: "All locations" },
    ...health.byLocation.map((l) => ({ value: l.locationId, label: l.locationName })),
  ];

  return (
    <section
      className="min-w-0 rounded-xl p-4"
      style={{ background: "var(--hero)", color: "var(--hero-ink)" }}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-[12.5px] font-semibold" style={{ color: "var(--hero-muted)" }}>
          Stock health
        </h2>
        <div className="flex items-center gap-2">
          {health.byLocation.length > 0 ? (
            <Dropdown ariaLabel="Location" options={options} value={where} onChange={setWhere} />
          ) : null}
          {settings}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3.5">
        <svg
          role="img"
          aria-label={healthyPercent === null ? "No items have a reorder level" : `${percent}% of items at or above reorder level`}
          viewBox="0 0 100 100"
          className="block size-[120px] shrink-0"
        >
          <circle cx={50} cy={50} r={R} fill="none" stroke="rgba(255,255,255,.2)" strokeWidth={12} />
          {healthyPercent !== null && percent > 0 ? (
            <circle
              cx={50}
              cy={50}
              r={R}
              fill="none"
              stroke={TONE.ok}
              strokeWidth={12}
              strokeLinecap="round"
              strokeDasharray={`${(percent / 100) * C} ${C}`}
              transform="rotate(-90 50 50)"
            />
          ) : null}
          <text x={50} y={57} textAnchor="middle" fontSize={22} fontWeight={700} fill="#fff">
            {healthyPercent === null ? "n/a" : `${percent}%`}
          </text>
        </svg>

        <div className="min-w-[120px] flex-1">
          <p className="mb-1.5 text-3xl leading-none font-bold tabular-nums">{inStore}</p>
          <p className="text-xs" style={{ color: "var(--hero-muted)" }}>
            {scope === "bottles" ? "bottles" : scope === "bulk" ? "bulk units" : "items"} in store{location ? ` at ${location.locationName}` : ""}.{" "}
            {healthyPercent === null
              ? "Set a reorder level on an item type to see its stock health."
              : belowReorder === 0
                ? "Every item is at or above its reorder level."
                : `${belowReorder} ${belowReorder === 1 ? "item" : "items"} below reorder level.`}
          </p>
        </div>
      </div>

      {items.map((i) => (
        <div key={i.itemName}>
          <div className="mt-2.5 mb-1 flex justify-between gap-2 text-xs">
            <span>{i.itemName}</span>
            <b className="tabular-nums" title={stockText(i, unit)}>
              {i.level}%
            </b>
          </div>
          <div
            role="progressbar"
            aria-label={`${i.itemName} stock level`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={i.level}
            aria-valuetext={stockText(i, unit)}
            className="h-2 overflow-hidden rounded-full bg-white/20"
          >
            <i className="block h-full rounded-full" style={{ width: `${i.level}%`, background: TONE[levelTone(i.level)] }} />
          </div>
        </div>
      ))}
    </section>
  );
}
