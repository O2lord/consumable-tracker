"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";

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

// A touch screen (phone, tablet) is the main pointer. There, grabbing focus would pop up the on-screen
// keyboard over the page, so the always-focused behaviour is for mouse-and-keyboard computers only.
const TOUCH = "(pointer: coarse)";
export const isTouchScreen = () => typeof window !== "undefined" && window.matchMedia(TOUCH).matches;
export function subscribeTouch(onChange: () => void) {
  const query = window.matchMedia(TOUCH);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

const serialSupported = () => getSerial() !== undefined && !isTouchScreen();
// The scanner in USB serial (CDC) mode reports these USB IDs (Microchip 04D8:000A). Used so the browser's
// device picker lists only the scanner and not every serial port on the computer.
const SCANNER_FILTERS = [{ usbVendorId: 0x04d8, usbProductId: 0x000a }];

// If a scanner is set to send no terminator, a code that has stopped arriving for this long is complete.
const IDLE_FLUSH_MS = 120;
const OPEN_RETRIES = 5;

/**
 * Reads a USB barcode scanner in serial (CDC) mode through Web Serial (Chrome/Edge). Use this on a Mac, where macOS
 * drops the keystrokes of this scanner in keyboard mode. The person presses "Connect scanner" once and picks the
 * scanner; the browser remembers it and this reconnects automatically on later visits and when it is plugged in.
 * Every code read is passed to `onScan`. On a touch screen it does nothing.
 */
export function useSerialScanner(onScan: (value: string) => void | Promise<void>, disabled = false) {
  const [serialConnected, setSerialConnected] = useState(false);
  const [serialBusy, setSerialBusy] = useState(false);
  const canUseSerial = useSyncExternalStore(subscribeNever, serialSupported, () => false);

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
      serial
        .getPorts()
        .then((ports) => {
          if (!disposed && ports[0]) void readFrom(ports[0]);
        })
        .catch(() => {});
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

  return {
    canUseSerial,
    serialConnected,
    serialBusy,
    /** Opens the browser's scanner picker (or reopens the one already allowed). */
    connect: () => void connectRef.current?.(),
  };
}
