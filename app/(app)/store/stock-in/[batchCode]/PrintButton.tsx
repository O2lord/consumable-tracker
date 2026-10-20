"use client";

import { useState } from "react";
import { buttonClass } from "@/components/ui/styles";

/**
 * Sends the labels to the Zebra printer through POST /api/labels and reports the result. Give a batch or a delivery,
 * and `only` to print just one part of it (see /api/labels).
 */
export function PrintButton({
  batch,
  delivery,
  only,
  label,
  plain = false,
}: {
  batch?: string;
  delivery?: string;
  only?: string;
  label?: string;
  /** Show it as a plain text link instead of a button, for placing next to a title. */
  plain?: boolean;
}) {
  const [state, setState] = useState<{ busy: boolean; error?: string; message?: string }>({ busy: false });

  async function print() {
    setState({ busy: true });
    try {
      const res = await fetch("/api/labels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(delivery ? { delivery, only } : { batch, only }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; sent?: number };
      if (!res.ok) setState({ busy: false, error: body.error ?? "Printing failed" });
      else setState({ busy: false, message: `Sent ${body.sent ?? 0} label(s) to the printer.` });
    } catch {
      setState({ busy: false, error: "Could not reach the server. Check your connection and try again." });
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <button
        type="button"
        onClick={print}
        disabled={state.busy}
        className={plain ? "text-sm font-semibold text-side-title underline disabled:opacity-60" : buttonClass}
      >
        {state.busy ? "Printing..." : (label ?? "Print to label printer")}
      </button>
      {state.error ? (
        <p role="alert" className="text-sm text-red-600">
          {state.error}
        </p>
      ) : null}
      {state.message ? (
        <p role="status" className="text-sm text-green-700">
          {state.message}
        </p>
      ) : null}
    </div>
  );
}
