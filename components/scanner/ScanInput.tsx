"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ghostButtonClass } from "@/components/ui/styles";

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

// Minimal Web Serial typings (Chrome/Edge only), so no extra @types package is needed.
interface SerialPortLike {
  readable: ReadableStream<Uint8Array> | null;
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
}
interface SerialLike extends EventTarget {
  getPorts(): Promise<SerialPortLike[]>;
  requestPort(options?: { filters: { usbVendorId: number; usbProductId?: number }[] }): Promise<SerialPortLike>;
}
const getSerial = (): SerialLike | undefined =>
  typeof navigator === "undefined" ? undefined : (navigator as unknown as { serial?: SerialLike }).serial;
const subscribeNever = () => () => {};
const serialSupported = () => getSerial() !== undefined && !isTouchScreen();
// The scanner in USB serial (CDC) mode reports these USB IDs (Microchip 04D8:000A). Used so the browser's
// device picker lists only the scanner and not every serial port on the computer.
const SCANNER_FILTERS = [{ usbVendorId: 0x04d8, usbProductId: 0x000a }];

// If a scanner is set to send no terminator, a code that has stopped arriving for this long is complete.
const IDLE_FLUSH_MS = 120;
const OPEN_RETRIES = 5;

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
 * Captures a barcode scanner and offers the device camera as a stand-in when there is no scanner.
 *
 * Two scanner paths, both feeding onScan:
 *  - USB keyboard mode: the scanner types the code and presses Enter into the focused field.
 *  - USB serial (CDC) mode: Chrome/Edge read the scanner directly through Web Serial. Use this on a Mac,
 *    where macOS drops the keystrokes of this scanner in keyboard mode. Press "Connect scanner" once and
 *    pick the scanner; the browser remembers it and reconnects automatically on later visits.
 *
 * On a computer it keeps focus so the next scan lands here without touching the screen: if focus drops
 * to nothing (the page body), it comes back. It never steals focus from another field the person has
 * deliberately clicked into. On a touch screen it leaves focus alone.
 */
export function ScanInput({ onScan, disabled = false, label = "Scan a barcode", status = "idle" }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [serialConnected, setSerialConnected] = useState(false);
  const [serialBusy, setSerialBusy] = useState(false);
  const canUseSerial = useSyncExternalStore(subscribeNever, serialSupported, () => false);
  const touch = useSyncExternalStore(subscribeTouch, isTouchScreen, () => false);

  useEffect(() => {
    if (!disabled && !isTouchScreen()) inputRef.current?.focus();
  }, [disabled]);

  const onScanRef = useRef(onScan);
  const disabledRef = useRef(disabled);
  useEffect(() => {
    onScanRef.current = onScan;
    disabledRef.current = disabled;
  });

  // Set while the serial effect is mounted; the "Connect scanner" button calls it.
  const connectRef = useRef<(() => Promise<void>) | null>(null);

  useEffect(() => {
    if (isTouchScreen()) return;
    const serial = getSerial();
    if (!serial) return;

    let disposed = false;
    let activePort: SerialPortLike | null = null;
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let flushTimer: number | undefined;

    async function readFrom(port: SerialPortLike, attempt = 0): Promise<void> {
      if (disposed || activePort) return;
      try {
        await port.open({ baudRate: 9600 });
      } catch {
        // Still held by a previous session (e.g. a hot reload), or in use by another tab: retry briefly.
        if (!disposed && attempt < OPEN_RETRIES) {
          window.setTimeout(() => void readFrom(port, attempt + 1), 500);
        } else if (!disposed) {
          setSerialBusy(true);
        }
        return;
      }
      if (disposed || !port.readable) {
        await port.close().catch(() => {});
        return;
      }
      activePort = port;
      setSerialConnected(true);
      setSerialBusy(false);

      const decoder = new TextDecoder();
      let buffer = "";
      const emit = (raw: string) => {
        const code = raw.trim();
        if (code && !disabledRef.current) void onScanRef.current(code);
      };
      const flush = () => {
        const pending = buffer;
        buffer = "";
        emit(pending);
      };

      reader = port.readable.getReader();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          window.clearTimeout(flushTimer);
          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split(/[\r\n]+/);
          buffer = parts.pop() ?? "";
          for (const part of parts) emit(part);
          if (buffer) flushTimer = window.setTimeout(flush, IDLE_FLUSH_MS);
        }
      } catch {
        // The scanner was unplugged or the port closed.
      } finally {
        window.clearTimeout(flushTimer);
        reader.releaseLock();
        reader = null;
        await port.close().catch(() => {});
        activePort = null;
        if (!disposed) setSerialConnected(false);
      }
    }

    // Reconnect to a scanner the person already allowed for this site, now and whenever it is plugged in.
    const reconnect = () => {
      serial.getPorts().then((ports) => {
        if (!disposed && ports[0]) void readFrom(ports[0]);
      }).catch(() => {});
    };
    reconnect();
    serial.addEventListener("connect", reconnect);

    connectRef.current = async () => {
      setSerialBusy(false);
      try {
        // A scanner already allowed for this site is reopened without the browser's device picker.
        const paired = await serial.getPorts();
        const port = paired[0] ?? (await serial.requestPort({ filters: SCANNER_FILTERS }));
        void readFrom(port);
      } catch {
        // The person closed the picker without choosing a device.
      }
    };

    return () => {
      disposed = true;
      connectRef.current = null;
      serial.removeEventListener("connect", reconnect);
      window.clearTimeout(flushTimer);
      void reader?.cancel().catch(() => {});
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
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => setCameraOpen(true)} className={`${ghostButtonClass} py-1`}>
            Use camera
          </button>
          {canUseSerial && !serialConnected ? (
            <button
              type="button"
              onClick={() => void connectRef.current?.()}
              className={`${ghostButtonClass} py-1`}
            >
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
