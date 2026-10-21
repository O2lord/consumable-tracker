"use client";

import { useState } from "react";
import { sendToBridge } from "@/lib/print-bridge";

/**
 * Prints only the transfer barcode (a small label with the code under it) so it can be stuck on the box.
 * It goes straight to the label printer through the print helper on this computer, the same way the batch and
 * delivery labels do (see lib/print-bridge.ts): the page fetches the printer commands and the helper prints them.
 */
export function PrintBarcodeButton({ code, className }: { code: string; className?: string }) {
  const [state, setState] = useState<{ busy: boolean; error?: string; message?: string }>({ busy: false });

  async function print() {
    setState({ busy: true });
    try {
      const res = await fetch(`/api/transfers/${encodeURIComponent(code)}?format=tspl`, { cache: "no-store" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "Could not get the barcode");
      }
      await sendToBridge(await res.text());
      setState({ busy: false, message: "Barcode sent to the printer." });
    } catch (err) {
      setState({ busy: false, error: err instanceof Error ? err.message : "Printing failed" });
    }
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <button type="button" onClick={print} disabled={state.busy} className={className}>
        {state.busy ? "Printing…" : "Print barcode"}
      </button>
      {state.error ? (
        <p role="alert" className="max-w-xs text-sm text-red-600">
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
