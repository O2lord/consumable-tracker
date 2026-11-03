"use client";

import { useState } from "react";
import { printTsplUrls, useUsbMode, usbErrorMessage } from "./usb-print";

/**
 * One print control for one label (or a few that are always printed together). On a PC it opens the PDF, which is
 * printed with the system print window. On a phone or tablet that can talk to the printer over USB it prints
 * straight to the printer instead. Only one of the two is ever shown, so there is never a second button.
 *
 * `pdfHref` and `tsplHref` are the same labels in the two formats. For several labels with a choice of which ones,
 * link to the preview page instead (/api/labels?...&format=preview), which does the same switch.
 */
export function SmartPrint({
  pdfHref,
  tsplHref,
  children,
  className,
}: {
  pdfHref: string;
  tsplHref: string;
  children: React.ReactNode;
  className?: string;
}) {
  const usb = useUsbMode();
  const [state, setState] = useState<"idle" | "busy" | "done" | "error">("idle");
  const [message, setMessage] = useState("");

  if (!usb) {
    return (
      <a href={pdfHref} target="_blank" rel="noreferrer" className={className}>
        {children}
      </a>
    );
  }

  async function onClick() {
    setState("busy");
    setMessage("");
    try {
      await printTsplUrls([tsplHref]);
      setState("done");
      setMessage("Sent to the printer.");
    } catch (err) {
      setState("error");
      setMessage(usbErrorMessage(err));
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
