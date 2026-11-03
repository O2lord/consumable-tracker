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

// Minimal WebUSB typings. Used where the browser has no Web Serial (Chrome on an Android phone or tablet): a scanner
// in USB serial (CDC) mode is read straight from its USB data endpoint instead, which gives the same bytes.
interface UsbEndpointLike {
  endpointNumber: number;
  direction: "in" | "out";
  type: string;
  packetSize?: number;
}
interface UsbInterfaceLike {
  interfaceNumber: number;
  alternates: { interfaceClass: number; endpoints: UsbEndpointLike[] }[];
}
interface UsbDeviceLike {
  vendorId: number;
  productId: number;
  opened: boolean;
  configuration: { interfaces: UsbInterfaceLike[] } | null;
  open(): Promise<void>;
  close(): Promise<void>;
  selectConfiguration(value: number): Promise<void>;
  claimInterface(n: number): Promise<void>;
  releaseInterface(n: number): Promise<void>;
  controlTransferOut(
    setup: { requestType: "class"; recipient: "interface"; request: number; value: number; index: number },
  ): Promise<{ status: string }>;
  transferIn(endpoint: number, length: number): Promise<{ status: string; data?: DataView }>;
}
interface UsbLike extends EventTarget {
  getDevices(): Promise<UsbDeviceLike[]>;
  requestDevice(options: { filters: { vendorId: number; productId?: number }[] }): Promise<UsbDeviceLike>;
}

const getSerial = (): SerialLike | undefined =>
  typeof navigator === "undefined" ? undefined : (navigator as unknown as { serial?: SerialLike }).serial;
const getUsb = (): UsbLike | undefined =>
  typeof navigator === "undefined" ? undefined : (navigator as unknown as { usb?: UsbLike }).usb;
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

// A phone or tablet can read the scanner too, so touch screens are no longer excluded. Web Serial is used when the
// browser has it, otherwise WebUSB.
const serialSupported = () => getSerial() !== undefined || getUsb() !== undefined;
// The scanner's real USB IDs are not assumed: the one the person picks is remembered and matched on later visits.
const SAVED_KEY = "scanner-usb-id";
const readSavedScanner = (): { v: number; p: number } | null => {
  try {
    const raw = window.localStorage.getItem(SAVED_KEY);
    return raw ? (JSON.parse(raw) as { v: number; p: number }) : null;
  } catch {
    return null;
  }
};
const saveScanner = (d: UsbDeviceLike) => {
  try {
    window.localStorage.setItem(SAVED_KEY, JSON.stringify({ v: d.vendorId, p: d.productId }));
  } catch {
    /* storage can be blocked */
  }
};
const isScannerDevice = (d: UsbDeviceLike) => {
  const saved = readSavedScanner();
  return !!saved && d.vendorId === saved.v && d.productId === saved.p;
};

// Turns the browser's raw error into something a person can act on, keeping the original text in brackets.
const explainError = (err: unknown): string => {
  const raw = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  if (/claim ?interface|unable to claim/i.test(raw)) {
    return `The scanner was found, but another app or tab is holding it. Unplug the scanner, plug it back in, close other tabs of this site, then tap Connect scanner again. (${raw})`;
  }
  if (/no compatible devices|NotFoundError/i.test(raw)) {
    return `No scanner was found. Check that it is plugged in and in USB serial (CDC) mode. (${raw})`;
  }
  if (/SecurityError|NotAllowedError|access denied/i.test(raw)) {
    return `Permission to use the scanner was refused. Allow USB access when Chrome asks. (${raw})`;
  }
  return raw;
};

// If a scanner is set to send no terminator, a code that has stopped arriving for this long is complete.
const IDLE_FLUSH_MS = 120;
const OPEN_RETRIES = 5;
const CDC_COMM_CLASS = 0x02;
const CDC_DATA_CLASS = 0x0a;

/** Something that hands over the scanner's bytes, however they are read. */
interface ChunkSource {
  /** The next bytes, or null when the scanner went away. */
  read(): Promise<Uint8Array | null>;
  /** Stop a read that is waiting. */
  cancel(): Promise<void>;
  /** Give the scanner back. */
  close(): Promise<void>;
}

async function openSerialSource(port: SerialPortLike): Promise<ChunkSource> {
  await port.open({ baudRate: 9600 });
  if (!port.readable) {
    await port.close().catch(() => {});
    throw new Error("The scanner port has nothing to read.");
  }
  const reader = port.readable.getReader();
  return {
    async read() {
      const { value, done } = await reader.read();
      return done ? null : (value ?? new Uint8Array());
    },
    cancel: () => reader.cancel().catch(() => {}),
    async close() {
      reader.releaseLock();
      await port.close().catch(() => {});
    },
  };
}

async function openUsbSource(device: UsbDeviceLike): Promise<ChunkSource> {
  if (!device.opened) await device.open();
  if (!device.configuration) await device.selectConfiguration(1);

  // The data interface of a CDC device has a bulk IN endpoint: that is where the scanned text arrives.
  let data: { iface: number; endpoint: number; packetSize: number; isCdcData: boolean } | null = null;
  let comm: number | null = null;
  for (const iface of device.configuration?.interfaces ?? []) {
    for (const alt of iface.alternates) {
      if (alt.interfaceClass === CDC_COMM_CLASS && comm === null) comm = iface.interfaceNumber;
      const bulkIn = alt.endpoints.find((e) => e.direction === "in" && e.type === "bulk");
      if (!bulkIn) continue;
      const isCdcData = alt.interfaceClass === CDC_DATA_CLASS;
      if (!data || (isCdcData && !data.isCdcData)) {
        data = { iface: iface.interfaceNumber, endpoint: bulkIn.endpointNumber, packetSize: bulkIn.packetSize ?? 64, isCdcData };
      }
    }
  }
  if (!data) throw new Error("This USB device has no scanner endpoint.");
  await device.claimInterface(data.iface);

  // Some scanners only send once the "serial port" is opened (DTR and RTS raised). Harmless for the ones that do not care.
  if (comm !== null) {
    try {
      await device.claimInterface(comm);
      await device.controlTransferOut({ requestType: "class", recipient: "interface", request: 0x22, value: 0x03, index: comm });
    } catch {
      /* not needed by every scanner */
    }
  }

  return {
    async read() {
      // Ask for a whole packet at a time: a smaller buffer than the endpoint's packet size ends in a "babble" error.
      const result = await device.transferIn(data.endpoint, Math.max(data.packetSize, 64));
      if (result.status !== "ok") return null;
      return result.data ? new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength) : new Uint8Array();
    },
    // Closing the device ends a transferIn that is waiting.
    cancel: () => device.close().catch(() => {}),
    async close() {
      await device.releaseInterface(data.iface).catch(() => {});
      await device.close().catch(() => {});
    },
  };
}

/**
 * Reads a USB barcode scanner in serial (CDC) mode, through Web Serial where the browser has it (Chrome/Edge on a
 * computer) or WebUSB otherwise (Chrome on an Android phone or tablet). Use this on a Mac, where macOS drops the
 * keystrokes of this scanner in keyboard mode, and on a tablet whose scanner is in serial mode. The person presses
 * "Connect scanner" once and picks the scanner; the browser remembers it and this reconnects automatically on later
 * visits and when it is plugged in. Every code read is passed to `onScan`.
 */
export function useSerialScanner(onScan: (value: string) => void | Promise<void>, disabled = false) {
  const [serialConnected, setSerialConnected] = useState(false);
  const [serialBusy, setSerialBusy] = useState(false);
  // Why the scanner could not be opened, in the browser's own words, so a failure on a tablet can be diagnosed.
  const [serialError, setSerialError] = useState<string | null>(null);
  const canUseSerial = useSyncExternalStore(subscribeNever, serialSupported, () => false);

  const onScanRef = useRef(onScan);
  const disabledRef = useRef(disabled);
  useEffect(() => {
    onScanRef.current = onScan;
    disabledRef.current = disabled;
  });

  // Set while the effect is mounted; the "Connect scanner" button calls it.
  const connectRef = useRef<(() => Promise<void>) | null>(null);

  useEffect(() => {
    // Web Serial is used wherever the browser has it (including Chrome on Android); WebUSB only as a fallback.
    const serial = getSerial();
    const usb = serial ? undefined : getUsb();
    if (!serial && !usb) return;

    let disposed = false;
    let active: ChunkSource | null = null;
    let flushTimer: number | undefined;

    async function run(open: () => Promise<ChunkSource>, attempt = 0): Promise<void> {
      if (disposed || active) return;
      let source: ChunkSource;
      try {
        source = await open();
      } catch (err) {
        // Still held by a previous session (e.g. a hot reload), or in use by another tab: retry briefly.
        if (!disposed && attempt < OPEN_RETRIES) {
          window.setTimeout(() => void run(open, attempt + 1), 500);
        } else if (!disposed) {
          setSerialBusy(true);
          setSerialError(explainError(err));
        }
        return;
      }
      if (disposed) {
        await source.close();
        return;
      }
      active = source;
      setSerialConnected(true);
      setSerialBusy(false);
      setSerialError(null);

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

      try {
        while (true) {
          const value = await source.read();
          if (value === null) break;
          if (value.length === 0) continue;
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
        await source.close();
        active = null;
        if (!disposed) setSerialConnected(false);
      }
    }

    const openSerial = (port: SerialPortLike) => () => openSerialSource(port);
    const openUsb = (device: UsbDeviceLike) => () => openUsbSource(device);

    // Reconnect to a scanner the person already allowed for this site, now and whenever it is plugged in.
    const reconnect = () => {
      if (serial) {
        serial
          .getPorts()
          .then((ports) => {
            if (!disposed && ports[0]) void run(openSerial(ports[0]));
          })
          .catch(() => {});
      } else if (usb) {
        usb
          .getDevices()
          .then((devices) => {
            const scanner = devices.find(isScannerDevice);
            if (!disposed && scanner) void run(openUsb(scanner));
          })
          .catch(() => {});
      }
    };
    reconnect();
    (serial ?? usb)?.addEventListener("connect", reconnect);

    connectRef.current = async () => {
      setSerialBusy(false);
      setSerialError(null);
      try {
        // A scanner already allowed for this site is reopened without the browser's device picker.
        if (serial) {
          const paired = await serial.getPorts();
          // No filter: the scanner's USB IDs vary by model, and a wrong filter made the picker say "No compatible devices found".
          const port = paired[0] ?? (await serial.requestPort());
          void run(openSerial(port));
        } else if (usb) {
          const paired = (await usb.getDevices()).find(isScannerDevice);
          const device = paired ?? (await usb.requestDevice({ filters: [] }));
          saveScanner(device);
          void run(openUsb(device));
        }
      } catch (err) {
        // The person closed the picker without choosing a device: nothing to report. Anything else is shown.
        if (!(err instanceof Error) || err.name !== "NotFoundError") {
          setSerialError(explainError(err));
        }
      }
    };

    return () => {
      disposed = true;
      connectRef.current = null;
      (serial ?? usb)?.removeEventListener("connect", reconnect);
      window.clearTimeout(flushTimer);
      void active?.cancel();
    };
  }, []);

  return {
    canUseSerial,
    serialConnected,
    serialBusy,
    serialError,
    /** Opens the browser's scanner picker (or reopens the one already allowed). */
    connect: () => void connectRef.current?.(),
  };
}
