"use client";

import { usePrinterConnection } from "@/components/labels/usb-print";
import { useScannerSetup } from "@/components/scanner/useSerialScanner";

/**
 * One place, in the top bar, to connect the USB label printer and the USB barcode scanner. Each is picked once and
 * remembered by the browser; every page that prints or scans then uses it without asking again. It shows only
 * what this device can do (the printer on a phone or tablet that prints over USB, the scanner where the browser
 * can read a USB scanner) and nothing at all on a device that can do neither.
 */
export function DeviceConnect() {
  const printer = usePrinterConnection();
  const scanner = useScannerSetup();
  if (!printer.usbMode && !scanner.supported) return null;

  const allSet = (!printer.usbMode || printer.connected) && (!scanner.supported || scanner.ready);

  return (
    <details className="relative">
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-xl border border-line bg-surface px-3 py-2 text-sm">
        <span
          aria-hidden="true"
          className={`inline-block size-2 rounded-full ${allSet ? "bg-ok" : "bg-muted"}`}
        />
        Devices
      </summary>
      <div className="absolute right-0 z-20 mt-2 flex w-72 max-w-[85vw] flex-col gap-4 rounded-xl border border-line bg-surface p-4 shadow-lg">
        {printer.usbMode ? (
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium uppercase text-muted">Label printer</span>
            <span className="text-sm">{printer.connected ? `Connected${printer.name ? `: ${printer.name}` : ""}` : "Not connected"}</span>
            <button
              type="button"
              onClick={() => void printer.connect()}
              disabled={printer.busy}
              className="self-start text-sm underline"
            >
              {printer.busy ? "Choosing..." : printer.connected ? "Change printer" : "Connect printer"}
            </button>
            {printer.error ? (
              <span role="alert" className="text-xs text-bad">
                {printer.error}
              </span>
            ) : null}
          </div>
        ) : null}
        {scanner.supported ? (
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium uppercase text-muted">Barcode scanner</span>
            <span className="text-sm">{scanner.ready ? `Connected${scanner.name ? `: ${scanner.name}` : ""}` : "Not connected"}</span>
            <button
              type="button"
              onClick={() => void scanner.choose()}
              disabled={scanner.busy}
              className="self-start text-sm underline"
            >
              {scanner.busy ? "Choosing..." : scanner.ready ? "Change scanner" : "Connect scanner"}
            </button>
            {scanner.error ? (
              <span role="alert" className="text-xs text-bad">
                {scanner.error}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
    </details>
  );
}
