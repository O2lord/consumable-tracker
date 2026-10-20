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
    case "unit":
      return {
        ok: true,
        text:
          r.state === "IN_TRANSIT"
            ? `${r.itemName}: in transit, sent from ${r.locationName} (batch ${r.batchCode})`
            : `${r.itemName}: ${r.state.replace(/_/g, " ").toLowerCase()} at ${r.locationName} (batch ${r.batchCode}${r.expiryDate ? `, expires ${r.expiryDate}` : ""})`,
      };
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
    case "pack":
      return {
        ok: true,
        text: `${r.itemName}: pack or roll with ${r.piecesRemaining} of ${r.piecesPerPack} pieces left at ${r.locationName} (batch ${r.batchCode}${r.expiryDate ? `, expires ${r.expiryDate}` : ""})`,
      };
    case "batch":
      return { ok: true, text: `Batch of ${r.quantity} x ${r.itemName} (${r.trackingMode})${r.lotNo ? `, lot ${r.lotNo}` : ""}` };
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
