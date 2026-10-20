"use client";

import Link from "next/link";
import { useState } from "react";
import { FormDialogProvider } from "@/components/forms/FormDialog";
import { Modal } from "@/components/ui/Modal";
import { ResolveForm } from "./ResolveForm";
import { getTraceAction, type TraceView } from "./actions";

export interface TraceItem {
  transferItemId: string;
  transferId: string;
  transferCode: string;
  /** Null for a bulk batch. */
  serial: string | null;
  batchCode: string;
  itemName: string;
  fromName: string;
  toName: string;
  outstanding: number;
  /** The outstanding quantity is loose pieces, not packs. */
  inPieces: boolean;
}

interface Props {
  item: TraceItem;
  canResolve: boolean;
  /** May open the full bottle history report. */
  canSeeHistory: boolean;
  otherLocations: { id: string; name: string }[];
}

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) : "");

/**
 * "Trace" on one open discrepancy. The pop-up shows what happened to the item, step by step, and below it
 * the resolve form (for roles that may resolve). The timeline is fetched when the pop-up opens.
 */
export function TraceButton({ item, canResolve, canSeeHistory, otherLocations }: Props) {
  const [open, setOpen] = useState(false);
  const [trace, setTrace] = useState<TraceView | null | "loading">("loading");

  async function show() {
    setOpen(true);
    setTrace("loading");
    try {
      setTrace(await getTraceAction(item.transferId, item.serial));
    } catch {
      setTrace(null);
    }
  }

  const name = item.serial ?? item.batchCode;

  return (
    <>
      <button
        type="button"
        onClick={show}
        className="rounded-lg border border-line bg-surface px-3 py-1.5 text-sm font-medium text-ink hover:bg-brand-soft"
      >
        Trace
      </button>

      {open ? (
        <Modal title={`Trace ${name}`} onClose={() => setOpen(false)}>
          <div className="flex flex-col gap-6">
            <div className="flex flex-col gap-1 text-sm">
              <p>
                <span className="font-medium">{item.itemName}</span>
                <span className="text-zinc-500">
                  {" "}
                  · {item.fromName} to {item.toName}
                </span>
              </p>
              <p className="text-zinc-500">
                Transfer <span className="font-mono text-ink">{item.transferCode}</span>
                {canSeeHistory && item.serial ? (
                  <>
                    {" · "}
                    <Link href={`/reports/bottle/${encodeURIComponent(item.serial)}`} className="underline">
                      Full bottle history
                    </Link>
                  </>
                ) : null}
              </p>
            </div>

            {trace !== "loading" && trace !== null && trace.handover.length > 0 ? (
              <section aria-label="Handover" className="flex flex-col gap-3">
                <h3 className="text-sm font-semibold">Handover</h3>
                <dl className="grid grid-cols-1 gap-x-8 gap-y-3 text-sm sm:grid-cols-2">
                  {trace.handover.map((s) => (
                    <div key={s.label}>
                      <dt className="text-xs text-zinc-500">{s.place ? `${s.label} at ${s.place}` : s.label}</dt>
                      <dd className="font-medium">
                        {s.who}
                        {s.at ? <span className="ml-2 font-normal text-zinc-500">{when(s.at)}</span> : null}
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>
            ) : null}

            <section aria-label="Timeline" className="flex flex-col gap-3">
              <h3 className="text-sm font-semibold">What happened</h3>
              {trace === "loading" ? (
                <p className="text-sm text-zinc-500">Loading the timeline…</p>
              ) : trace === null ? (
                <p className="text-sm text-zinc-500">The timeline could not be loaded. It may already be resolved.</p>
              ) : (
                <>
                  {trace.namesHidden ? (
                    <p className="text-sm text-zinc-500">Your role cannot see who was involved, so names are left out.</p>
                  ) : null}
                  {trace.steps.length === 0 && !trace.namesHidden ? (
                    <p className="text-sm text-zinc-500">Nothing recorded.</p>
                  ) : null}
                  <ol className="flex flex-col">
                    {trace.steps.map((s, i) => (
                      <li key={`${s.label}-${i}`} className="relative flex gap-3 pb-4 last:pb-0">
                        <span className="flex flex-col items-center" aria-hidden="true">
                          <span className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full bg-brand" />
                          {i < trace.steps.length - 1 ? <span className="mt-1 w-px flex-1 bg-line" /> : null}
                        </span>
                        <div className="min-w-0 text-sm">
                          <p className="font-medium">{s.label}</p>
                          <p className="text-zinc-500">
                            {[s.place, s.who, when(s.at)].filter(Boolean).join(" · ")}
                          </p>
                          {s.note ? <p className="mt-0.5">{s.note}</p> : null}
                        </div>
                      </li>
                    ))}
                  </ol>
                </>
              )}
            </section>

            <section aria-label="Resolve" className="flex flex-col gap-3 border-t border-line pt-5">
              <h3 className="text-sm font-semibold">Resolve</h3>
              {canResolve ? (
                <FormDialogProvider onSucceeded={() => setOpen(false)}>
                  <ResolveForm
                    transferItemId={item.transferItemId}
                    isSerial={item.serial !== null}
                    outstanding={item.outstanding}
                    inPieces={item.inPieces}
                    destinationName={item.toName}
                    otherLocations={otherLocations}
                  />
                </FormDialogProvider>
              ) : (
                <p className="text-sm text-zinc-500">A supervisor resolves this once it has been traced.</p>
              )}
            </section>
          </div>
        </Modal>
      ) : null}
    </>
  );
}
