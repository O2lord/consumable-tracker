"use client";

import { useState } from "react";

// Prints labels straight to a USB label printer (such as the Xprinter XP-365B) from the browser, with no driver and
// no print app. It fetches the TSPL commands from the same route the PDF comes from (so the sign-in cookie goes
// with the request), then sends them to the printer over WebUSB. Needs Chrome or Edge on HTTPS. The first print
// asks the user to pick the printer once; after that the browser remembers it.

/** The small part of the WebUSB API used here (the DOM typings do not always include it). */
interface UsbEndpoint {
  endpointNumber: number;
  direction: "in" | "out";
  type: "bulk" | "interrupt" | "isochronous";
}
interface UsbAlternate {
  endpoints: UsbEndpoint[];
}
interface UsbInterface {
  interfaceNumber: number;
  alternates: UsbAlternate[];
}
interface UsbDevice {
  opened: boolean;
  productName?: string;
  configuration: { interfaces: UsbInterface[] } | null;
  open(): Promise<void>;
  selectConfiguration(value: number): Promise<void>;
  claimInterface(n: number): Promise<void>;
  releaseInterface(n: number): Promise<void>;
  transferOut(endpoint: number, data: BufferSource): Promise<{ status: string }>;
  close(): Promise<void>;
}
interface UsbApi {
  getDevices(): Promise<UsbDevice[]>;
  requestDevice(options: { filters: object[] }): Promise<UsbDevice>;
}

const CHUNK = 4096;

function usbApi(): UsbApi | null {
  const usb = (navigator as unknown as { usb?: UsbApi }).usb;
  return usb ?? null;
}

/** Finds the interface that has a bulk OUT endpoint: that is where a label printer takes its commands. */
function findOutEndpoint(device: UsbDevice): { iface: number; endpoint: number } | null {
  for (const iface of device.configuration?.interfaces ?? []) {
    for (const alt of iface.alternates) {
      const out = alt.endpoints.find((e) => e.direction === "out" && e.type === "bulk");
      if (out) return { iface: iface.interfaceNumber, endpoint: out.endpointNumber };
    }
  }
  return null;
}

async function pickPrinter(usb: UsbApi): Promise<UsbDevice> {
  // A printer the user already allowed on this site is found again without asking.
  const known = await usb.getDevices();
  if (known.length === 1) return known[0];
  // No filter: the list shows every USB device and the user picks the printer.
  return usb.requestDevice({ filters: [] });
}

async function send(device: UsbDevice, text: string) {
  if (!device.opened) await device.open();
  if (!device.configuration) await device.selectConfiguration(1);
  const target = findOutEndpoint(device);
  if (!target) throw new Error("This USB device has no printer endpoint. Pick the label printer.");
  await device.claimInterface(target.iface);
  try {
    const bytes = new TextEncoder().encode(text);
    for (let i = 0; i < bytes.length; i += CHUNK) {
      const result = await device.transferOut(target.endpoint, bytes.slice(i, i + CHUNK));
      if (result.status !== "ok") throw new Error(`The printer did not accept the data (${result.status}).`);
    }
  } finally {
    await device.releaseInterface(target.iface).catch(() => {});
  }
}

/**
 * `query` is the part of the /api/labels address that says what to print, for example `batch=BT123&only=items`
 * or `serial=CN456`.
 */
export function UsbPrintButton({
  query,
  children,
  className,
}: {
  query: string;
  children: React.ReactNode;
  className?: string;
}) {
  const [state, setState] = useState<"idle" | "busy" | "done" | "error">("idle");
  const [message, setMessage] = useState("");

  async function onClick() {
    const usb = usbApi();
    if (!usb) {
      setState("error");
      setMessage("This browser cannot print over USB. Use Chrome or Edge.");
      return;
    }
    setState("busy");
    setMessage("");
    try {
      // Ask for the printer first: the browser only allows the picker straight after a tap.
      const device = await pickPrinter(usb);
      const res = await fetch(`/api/labels?${query}&format=tspl`, { credentials: "same-origin", cache: "no-store" });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `Could not get the labels (${res.status}).`);
      }
      await send(device, await res.text());
      setState("done");
      setMessage("Sent to the printer.");
    } catch (err) {
      setState("error");
      const name = err instanceof Error ? err.name : "";
      if (name === "NotFoundError") setMessage("No printer was chosen.");
      else if (name === "SecurityError" || name === "NetworkError")
        setMessage("Chrome could not open the printer. Unplug and replug it, then try again.");
      else setMessage(err instanceof Error ? err.message : "Printing failed.");
    }
  }

  return (
    <span className="inline-flex flex-col items-start gap-1">
      <button type="button" onClick={onClick} disabled={state === "busy"} className={className}>
        {state === "busy" ? "Printing..." : children}
      </button>
      {message ? (
        <span role="status" className={`text-xs ${state === "error" ? "text-red-600" : "text-muted"}`}>
          {message}
        </span>
      ) : null}
    </span>
  );
}
