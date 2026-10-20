"use client";

import { useEffect, useRef, useState } from "react";
import { ghostButtonClass } from "@/components/ui/styles";
import { ScanInput, type ScanStatus } from "./ScanInput";
import { ScanFeedback, type ScanOutcome } from "./ScanFeedback";

// Recent-scan rows: a coloured left edge and matching message colour for each result.
const ROW_EDGE: Record<ScanOutcome["kind"], string> = {
  ok: "border-ok",
  queued: "border-brand",
  duplicate: "border-warn",
  error: "border-bad",
};
const ROW_TEXT: Record<ScanOutcome["kind"], string> = {
  ok: "text-ok",
  queued: "text-brand",
  duplicate: "text-warn",
  error: "text-bad",
};

export interface ScanResult extends ScanOutcome {
  /** Set when this scan can be undone (the id the undo handler receives). */
  undoId?: string;
}

interface Entry {
  key: number;
  scanned: string;
  result: ScanResult;
  /** When the scan finished, in milliseconds since 1970. */
  at: number;
}

// "just now", "1 min ago", "5 min ago", then the clock time once it is over an hour old.
function ago(at: number, now: number): string {
  const mins = Math.floor((now - at) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  return new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

interface Props {
  label: string;
  /** Handle one scan. Throwing is treated as a failed scan, not a crash. */
  onScan: (value: string) => Promise<ScanResult>;
  /** If given, an "Undo last scan" button appears for scans that returned an undoId. */
  onUndo?: (undoId: string) => Promise<ScanOutcome>;
  /** Called after any scan or undo so the page can refresh its counts. */
  onChanged?: () => void;
  disabled?: boolean;
  /** How many recent scans to list. */
  historySize?: number;
  /** Calmer layout: Undo sits beside the result banner and the per-scan history list is left out. */
  compact?: boolean;
}

/**
 * A scanning session: always-focused input, big feedback, a short history, and optional undo of the
 * last scan. Server rejections come back as messages in the history rather than as exceptions.
 */
export function ScanSession({ label, onScan, onUndo, onChanged, disabled = false, historySize = 8, compact = false }: Props) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [outcome, setOutcome] = useState<ScanOutcome | null>(null);
  const [nonce, setNonce] = useState(0);
  const [busy, setBusy] = useState(false);
  const keyRef = useRef(0);
  // A clock that ticks while there is something to show, so "just now" turns into "1 min ago".
  const [now, setNow] = useState(() => new Date().getTime());
  const hasEntries = entries.length > 0;
  useEffect(() => {
    if (!hasEntries) return;
    const id = setInterval(() => setNow(new Date().getTime()), 15_000);
    return () => clearInterval(id);
  }, [hasEntries]);

  const last = entries[0];
  const canUndo = Boolean(onUndo && last?.result.undoId && last.result.kind === "ok" && !busy);

  function show(next: ScanOutcome) {
    setOutcome(next);
    setNonce((n) => n + 1);
  }

  async function handleScan(value: string) {
    setBusy(true);
    let result: ScanResult;
    try {
      result = await onScan(value);
    } catch {
      result = { kind: "error", message: "Could not process that scan. Check the connection and scan again" };
    }
    keyRef.current += 1;
    const at = new Date().getTime();
    const entry: Entry = { key: keyRef.current, scanned: value, result, at };
    setNow(at);
    setEntries((prev) => [entry, ...prev].slice(0, historySize));
    show(result);
    setBusy(false);
    onChanged?.();
  }

  async function handleUndo() {
    if (!onUndo || !last?.result.undoId) return;
    setBusy(true);
    let result: ScanOutcome;
    try {
      result = await onUndo(last.result.undoId);
    } catch {
      result = { kind: "error", message: "Could not undo. Try again" };
    }
    if (result.kind !== "error") {
      // The undone scan is no longer a valid thing to undo again.
      setEntries((prev) => prev.slice(1));
    }
    show(result);
    setBusy(false);
    onChanged?.();
  }

  const status: ScanStatus = outcome ? (outcome.kind === "ok" || outcome.kind === "queued" ? "ok" : "error") : "idle";

  return (
    <div className="flex flex-col gap-3">
      <ScanInput onScan={handleScan} disabled={disabled || busy} status={status} label={label} />
      {compact && onUndo ? (
        <div className="flex items-stretch gap-2">
          <div className="min-w-0 flex-1">
            <ScanFeedback outcome={outcome} nonce={nonce} />
          </div>
          <button
            type="button"
            onClick={handleUndo}
            disabled={!canUndo}
            className={`${ghostButtonClass} shrink-0 disabled:opacity-40`}
          >
            Undo
          </button>
        </div>
      ) : (
        <>
          <ScanFeedback outcome={outcome} nonce={nonce} />
          {onUndo ? (
            <div>
              <button
                type="button"
                onClick={handleUndo}
                disabled={!canUndo}
                className={`${ghostButtonClass} py-1 disabled:opacity-40`}
              >
                Undo last scan
              </button>
            </div>
          ) : null}
        </>
      )}
      {entries.length > 0 && !compact ? (
        <ul className="flex flex-col gap-1.5 text-sm">
          {entries.map((e) => (
            <li
              key={e.key}
              className={`flex flex-wrap items-center gap-x-3 gap-y-0.5 rounded-lg border-l-4 bg-page px-2.5 py-2 ${ROW_EDGE[e.result.kind]}`}
            >
              <span className="font-mono font-semibold">{e.scanned}</span>
              <span className={ROW_TEXT[e.result.kind]}>{e.result.message}</span>
              <span className="ml-auto text-xs text-muted">{ago(e.at, now)}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
