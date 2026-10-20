"use client";

import { useState } from "react";

/**
 * Prints only the transfer barcode (a small label with the code under it) so it can be stuck on the
 * box. The label PDF loads in a hidden frame and the print dialog opens straight away; if the browser
 * will not print from the frame, the PDF opens in a new tab instead.
 */
export function PrintBarcodeButton({ code, className }: { code: string; className?: string }) {
  const [busy, setBusy] = useState(false);

  function print() {
    setBusy(true);
    const url = `/api/transfers/${encodeURIComponent(code)}?format=label`;
    const frame = document.createElement("iframe");
    frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;";
    frame.onload = () => {
      try {
        frame.contentWindow?.focus();
        frame.contentWindow?.print();
      } catch {
        window.open(url, "_blank");
      }
      setBusy(false);
      setTimeout(() => frame.remove(), 60_000);
    };
    frame.src = url;
    document.body.appendChild(frame);
  }

  return (
    <button type="button" onClick={print} disabled={busy} className={className}>
      {busy ? "Preparing…" : "Print barcode"}
    </button>
  );
}
