"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ghostButtonClass } from "@/components/ui/styles";

// Loaded only when the camera is opened, so the decoder code stays out of every page's first load.
const CameraScanner = dynamic(() => import("./CameraScanner").then((m) => m.CameraScanner), { ssr: false });

// Local WebSocket served by scripts/scanner_bridge.py (8765 is the NFC bridge).
const SCANNER_BRIDGE_URL = "ws://localhost:8766";

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

// A touch screen (phone, tablet) is the main pointer. There, grabbing focus would pop up the on-screen
// keyboard over the page, so the always-focused behaviour is for mouse-and-keyboard computers only.
const TOUCH = "(pointer: coarse)";
const isTouchScreen = () => typeof window !== "undefined" && window.matchMedia(TOUCH).matches;
function subscribeTouch(onChange: () => void) {
  const query = window.matchMedia(TOUCH);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/**
 * Captures a USB/Bluetooth HID scanner, which types the code and presses Enter, and offers the device
 * camera as a stand-in when there is no scanner.
 * On a computer it keeps focus so the next scan lands here without touching the screen: if focus drops
 * to nothing (the page body), it comes back. It never steals focus from another field the person has
 * deliberately clicked into. On a touch screen it leaves focus alone.
 */
export function ScanInput({ onScan, disabled = false, label = "Scan a barcode", status = "idle" }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const touch = useSyncExternalStore(subscribeTouch, isTouchScreen, () => false);

  useEffect(() => {
    if (!disabled && !isTouchScreen()) inputRef.current?.focus();
  }, [disabled]);

  // Optional local bridge (scripts/scanner_bridge.py) for a Mac that drops the scanner's keystrokes. If it
  // is not running the connection just fails quietly and typed input works as before.
  const onScanRef = useRef(onScan);
  const disabledRef = useRef(disabled);
  useEffect(() => {
    onScanRef.current = onScan;
    disabledRef.current = disabled;
  });
  useEffect(() => {
    if (isTouchScreen()) return;
    let socket: WebSocket | null = null;
    let timer: number | undefined;
    let closed = false;
    const connect = () => {
      try {
        socket = new WebSocket(SCANNER_BRIDGE_URL);
      } catch {
        return;
      }
      socket.onmessage = (event) => {
        if (disabledRef.current) return;
        try {
          const message = JSON.parse(String(event.data)) as { type?: string; code?: unknown };
          const code = typeof message.code === "string" ? message.code.trim() : "";
          if (message.type === "scan" && code) void onScanRef.current(code);
        } catch {
          // Ignore anything that is not a scan message.
        }
      };
      socket.onclose = () => {
        if (!closed) timer = window.setTimeout(connect, 5000);
      };
      socket.onerror = () => socket?.close();
    };
    connect();
    return () => {
      closed = true;
      window.clearTimeout(timer);
      socket?.close();
    };
  }, []);

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
        <div>
          <button type="button" onClick={() => setCameraOpen(true)} className={`${ghostButtonClass} py-1`}>
            Use camera
          </button>
        </div>
      )}
    </div>
  );
}
