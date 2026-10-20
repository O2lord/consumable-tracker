"use client";

import { useState } from "react";
import { buttonClass } from "@/components/ui/styles";

/** The print helper (scripts/print_bridge.py) that runs on the computer the label printer is plugged into. */
const BRIDGE_URL = "ws://localhost:8767";
const BRIDGE_DOWN =
  "The print helper is not running on this computer. Ask whoever manages this PC to run the print helper installer (scripts/print-helper), or restart the PC if it was installed already.";

/** Sends the label commands to the print helper and resolves with how many labels it printed. */
function sendToBridge(tspl: string): Promise<number> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let socket: WebSocket;
    const finish = (err?: Error, labels = 0) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket?.close();
      if (err) reject(err);
      else resolve(labels);
    };
    const timer = setTimeout(() => finish(new Error("The print helper did not answer. Check the printer and try again.")), 15000);
    try {
      socket = new WebSocket(BRIDGE_URL);
    } catch {
      finish(new Error(BRIDGE_DOWN));
      return;
    }
    socket.onopen = () => socket.send(JSON.stringify({ type: "print", tspl }));
    socket.onerror = () => finish(new Error(BRIDGE_DOWN));
    socket.onclose = () => finish(new Error(BRIDGE_DOWN));
    socket.onmessage = (event) => {
      try {
        const reply = JSON.parse(String(event.data)) as { type?: string; labels?: number; message?: string };
        if (reply.type === "printed") finish(undefined, reply.labels ?? 0);
        else finish(new Error(reply.message ?? "Printing failed"));
      } catch {
        finish(new Error("The print helper gave an answer that could not be read"));
      }
    };
  });
}

/**
 * Prints labels to the label printer. Give a batch or a delivery, and `only` to print just one part of it
 * (see /api/labels).
 *  - via "bridge" (the default): the page fetches the label commands from the server and passes them to the
 *    print helper on this computer, which sends them to the USB printer. Works when the app is deployed.
 *  - via "server": the server sends them to a network printer itself (PRINTER_HOST).
 */
export function PrintButton({
  batch,
  delivery,
  only,
  label,
  plain = false,
  via = "bridge",
}: {
  batch?: string;
  delivery?: string;
  only?: string;
  label?: string;
  /** Show it as a plain text link instead of a button, for placing next to a title. */
  plain?: boolean;
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
