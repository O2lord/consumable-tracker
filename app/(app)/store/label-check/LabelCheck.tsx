"use client";

import { useState } from "react";
import Link from "next/link";
import { ScanInput, type ScanStatus } from "@/components/scanner/ScanInput";
import type { CodeLookup } from "@/server/services/lookup.service";
import { lookupLabelAction } from "./actions";
import type { Destination } from "./destination";

interface Row {
  id: number;
  scanned: string;
  result: CodeLookup | { kind: "failed" };
  destination: Destination | null;
}

function describe(row: Row): { ok: boolean; text: string } {
  const r = row.result;
  switch (r.kind) {
    case "unit": {
      // Name the pack the bottle came in; the batch only when it was received loose.
      const from = r.packCode ? `pack ${r.packCode}` : `batch ${r.batchCode}`;
      return {
        ok: true,
        text:
          r.state === "IN_TRANSIT"
            ? `${r.itemName}: in transit, sent from ${r.locationName} (${from})`
            : `${r.itemName}: ${r.state.replace(/_/g, " ").toLowerCase()} at ${r.locationName} (${from}${r.expiryDate ? `, expires ${r.expiryDate}` : ""})`,
      };
    }
    case "transfer":
      return {
        ok: true,
        text: `Transfer slip: ${r.fromName} to ${r.toName}, ${r.itemCount} item(s), ${r.status.replace(/_/g, " ").toLowerCase()}`,
      };
    case "delivery":
      return {
        ok: true,
        text: `Delivery${r.supplier ? ` from ${r.supplier}` : ""} into ${r.locationName}, ${r.itemCount} ${r.itemCount === 1 ? "item" : "items"}`,
      };
    case "carton":
      return {
        ok: true,
        text: `${r.itemName}: carton of ${r.packsCount} ${r.packsCount === 1 ? "pack" : "packs"}, at ${r.locationName} (batch ${r.batchCode}${r.expiryDate ? `, expires ${r.expiryDate}` : ""})`,
      };
    case "pack": {
      // Say what the pack is, then where it came from: its carton, or the batch when it was received loose.
      const size = `pack of ${r.piecesPerPack.toLocaleString("en-GB")}`;
      const left = r.piecesRemaining < r.piecesPerPack ? `, ${r.piecesRemaining.toLocaleString("en-GB")} left` : "";
      const from = r.cartonCode ? `carton ${r.cartonCode}` : `batch ${r.batchCode}`;
      return {
        ok: true,
        text: `${r.itemName}: ${size}${left}, at ${r.locationName} (${from}${r.expiryDate ? `, expires ${r.expiryDate}` : ""})`,
      };
    }
    case "batch": {
      // Say what the batch is made of, largest container first: cartons, else packs, else the individual items.
      const makeup =
        r.cartonCount > 0
          ? `${r.cartonCount.toLocaleString("en-GB")} ${r.cartonCount === 1 ? "carton" : "cartons"}`
          : r.packCount > 0
            ? `${r.packCount.toLocaleString("en-GB")} ${r.packCount === 1 ? "pack" : "packs"}`
            : `${r.quantity.toLocaleString("en-GB")} ${r.quantity === 1 ? "bottle" : "bottles"}`;
      return { ok: true, text: `Batch of ${makeup} of ${r.itemName} (${r.trackingMode})${r.lotNo ? `, lot ${r.lotNo}` : ""}` };
    }
    case "unknown":
      return { ok: false, text: "Valid format, but this code is not in the system" };
    case "invalid":
      return { ok: false, text: "Not a valid tracker code. The scan may be misread or the label damaged" };
    default:
      return { ok: false, text: "Could not check this code. Try again" };
  }
}

/** Scan a printed label and see what the system knows about it: the "does it read back" check. */
export function LabelCheck() {
  const [rows, setRows] = useState<Row[]>([]);
  const [status, setStatus] = useState<ScanStatus>("idle");
  const [busy, setBusy] = useState(false);

  async function onScan(value: string) {
    setBusy(true);
    let result: Row["result"];
    let destination: Destination | null = null;
    try {
      const response = await lookupLabelAction(value);
      result = response.result;
      destination = response.destination;
    } catch {
      result = { kind: "failed" };
    }
    const row: Row = { id: Date.now() + Math.random(), scanned: value, result, destination };
    setRows((prev) => [row, ...prev].slice(0, 15));
    setStatus(describe(row).ok ? "ok" : "error");
    setBusy(false);
  }

  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <ScanInput onScan={onScan} disabled={busy} status={status} label="Scan a printed label" />
      <ul className="flex flex-col gap-2">
        {rows.map((row) => {
          const d = describe(row);
          return (
            <li
              key={row.id}
              className={`rounded-xl border px-3 py-2 text-sm ${d.ok ? "border-ok bg-ok-soft" : "border-bad bg-bad-soft"}`}
            >
              <span className="font-mono font-medium">{row.scanned}</span>
              <br />
              <span className={d.ok ? "text-ok" : "text-bad"}>{d.text}</span>
              {row.destination ? (
                <Link
                  href={row.destination.href}
                  className="mt-2 flex w-fit items-center rounded-lg border border-line bg-surface px-3 py-1.5 text-sm font-medium text-ink hover:bg-brand-soft"
                >
                  {row.destination.label}
                </Link>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
