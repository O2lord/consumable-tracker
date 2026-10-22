"use client";

import { useState } from "react";
import { buttonClass } from "@/components/ui/styles";
import { sendToBridge } from "@/lib/print-bridge";

/**
 * Prints labels to the label printer. Give a batch or a delivery, and `only` to print just one part of it
 * (see /api/labels).
 *  - via "bridge" (the default): the page fetches the label commands from the server and passes them to the
 *    print helper on this computer (lib/print-bridge.ts), which sends them to the USB printer. Works when the app
 *    is deployed.
 *  - via "server": the server sends them to a network printer itself (PRINTER_HOST).
 */
export function PrintButton({
  batch,
  delivery,
  only,
  label,
  plain = false,
  fullWidth = false,
  via = "bridge",
}: {
  batch?: string;
  delivery?: string;
  only?: string;
  label?: string;
  /** Show it as a plain text link instead of a button, for placing next to a title. */
  plain?: boolean;
  /** Stretch the button to the width of its container. */
  fullWidth?: boolean;
  via?: "bridge" | "server";
}) {
  const [state, setState] = useState<{ busy: boolean; error?: string; message?: string }>({ busy: false });

  async function printViaServer(): Promise<number> {
    const res = await fetch("/api/labels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(delivery ? { delivery, only } : { batch, only }),
    });
    const body = (await res.json().catch(() => ({}))) as { error?: string; sent?: number };
    if (!res.ok) throw new Error(body.error ?? "Printing failed");
    return body.sent ?? 0;
  }

  async function printViaBridge(): Promise<number> {
    const target = delivery ? `delivery=${encodeURIComponent(delivery)}` : `batch=${encodeURIComponent(batch ?? "")}`;
    const scope = only ? `&only=${encodeURIComponent(only)}` : "";
    const res = await fetch(`/api/labels?${target}${scope}&format=tspl`, { cache: "no-store" });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? "Could not get the labels");
    }
    return sendToBridge(await res.text());
  }

  async function print() {
    setState({ busy: true });
    try {
      const sent = await (via === "server" ? printViaServer() : printViaBridge());
      setState({ busy: false, message: `Sent ${sent} label(s) to the printer.` });
    } catch (err) {
      setState({ busy: false, error: err instanceof Error ? err.message : "Printing failed" });
    }
  }

  return (
    <div className={`flex flex-wrap items-center gap-3 ${fullWidth ? "w-full" : ""}`}>
      <button
        type="button"
        onClick={print}
        disabled={state.busy}
        className={
          plain
            ? "text-sm font-semibold text-side-title underline disabled:opacity-60"
            : `${buttonClass} ${fullWidth ? "w-full" : ""}`
        }
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
