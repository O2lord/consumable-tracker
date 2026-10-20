"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ScanInput } from "@/components/scanner/ScanInput";

/** Scan (scanner or camera) or type a serial, then open that bottle's history. */
export function BottleSearch() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  function onScan(value: string) {
    setBusy(true);
    router.push(`/reports/bottle/${encodeURIComponent(value.trim().toUpperCase())}`);
  }

  return <ScanInput onScan={onScan} disabled={busy} label="Serial" />;
}
