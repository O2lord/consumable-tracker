"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ghostButtonClass } from "@/components/ui/styles";
import { isTouchScreen, subscribeTouch, useSerialScanner } from "./useSerialScanner";

// Loaded only when the camera is opened, so the decoder code stays out of every page's first load.
const CameraScanner = dynamic(() => import("./CameraScanner").then((m) => m.CameraScanner), { ssr: false });

export type ScanStatus = "idle" | "ok" | "error";

interface Props {
  /** Called with the trimmed scanned text when the scanner sends Enter, or the camera reads a code. */
  onScan: (value: string) => void | Promise<void>;
  disabled?: boolean;
  label?: string;
  status?: ScanStatus;
}

const BORDER: Record<ScanStatus, string> = {
  idle: "border-brand",
  ok: "border-ok ring-2 ring-ok/30",
  error: "border-bad ring-2 ring-bad/30",
};

/**
 * Captures a barcode scanner and offers the device camera as a stand-in when there is no scanner.
 *
 * Two scanner paths, both feeding onScan:
 *  - USB keyboard mode: the scanner types the code and presses Enter into the focused field.
 *  - USB serial (CDC) mode: Chrome/Edge read the scanner directly through Web Serial (see useSerialScanner). Use this
 *    on a Mac, where macOS drops the keystrokes of this scanner in keyboard mode. Press "Connect scanner" once and
 *    pick the scanner; the browser remembers it and reconnects automatically on later visits.
 *
 * On a computer it keeps focus so the next scan lands here without touching the screen: if focus drops
 * to nothing (the page body), it comes back. It never steals focus from another field the person has
 * deliberately clicked into. On a touch screen it leaves focus alone.
 */
export function ScanInput({ onScan, disabled = false, label = "Scan a barcode", status = "idle" }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const { canUseSerial, serialConnected, serialBusy, connect } = useSerialScanner(onScan, disabled);
  const touch = useSyncExternalStore(subscribeTouch, isTouchScreen, () => false);

  useEffect(() => {
    if (!disabled && !isTouchScreen()) inputRef.current?.focus();
  }, [disabled]);

  // On a touch screen, fetch the camera decoder in the background so the camera also works offline later.
  useEffect(() => {
    if (!isTouchScreen()) return;
    void import("./cameraDecoder").then((m) => m.warmDecoder()).catch(() => {});
  }, []);

  function refocusIfIdle() {
    if (isTouchScreen()) return;
    window.setTimeout(() => {
      const active = document.activeElement;
      if (!disabled && (!active || active === document.body)) inputRef.current?.focus();
    }, 0);
  }

  async function submit() {
    const input = inputRef.current;
    if (!input) return;
    const value = input.value.trim();
    input.value = "";
    if (!value) return;
    await onScan(value);
    inputRef.current?.focus();
  }

  return (
    <div className="flex flex-col gap-2">
      <label className="flex flex-col gap-1 text-sm font-medium">
        {label}
        <input
          ref={inputRef}
          data-autofocus={touch ? undefined : ""}
          type="text"
          autoComplete="off"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          inputMode={cameraOpen ? "none" : undefined}
          disabled={disabled}
          onBlur={refocusIfIdle}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void submit();
            }
          }}
          className={`rounded-xl border-2 bg-page px-4 py-3.5 font-mono text-lg text-ink ${BORDER[status]}`}
          placeholder={touch ? "Use the camera, or type a code" : "Point the scanner at a label"}
        />
        {disabled ? null : (
          <span className="text-xs font-normal text-muted">
            {touch ? "Tap the field to type a code." : "Scanner ready. Focus stays here."}
          </span>
        )}
      </label>
      {cameraOpen ? (
        <CameraScanner
          onCode={(value) => {
            void onScan(value);
          }}
          paused={disabled}
          onClose={() => setCameraOpen(false)}
        />
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => setCameraOpen(true)} className={`${ghostButtonClass} py-1`}>
            Use camera
          </button>
          {canUseSerial && !serialConnected ? (
            <button type="button" onClick={connect} className={`${ghostButtonClass} py-1`}>
              Connect scanner
            </button>
          ) : null}
          {serialConnected ? (
            <span className="text-xs font-normal text-muted">USB scanner connected.</span>
          ) : null}
          {serialBusy && !serialConnected ? (
            <span className="text-xs font-normal text-muted">
              The scanner is in use by the extension panel. Close the panel, then press Connect scanner.
            </span>
          ) : null}
        </div>
      )}
    </div>
  );
}
