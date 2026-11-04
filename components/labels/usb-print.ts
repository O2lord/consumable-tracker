"use client";

import { useCallback, useEffect, useState } from "react";
import { PRINTER_KEY, SCANNER_KEY, isSavedUsb, saveUsb } from "@/lib/usb-saved";

// Printing straight to a USB label printer (such as the Xprinter XP-365B) from the browser, over WebUSB.
// Phones and tablets cannot use the printer driver a PC uses, so there the page sends the printer its own
// commands (TSPL) instead of a PDF. A PC keeps the PDF and the system print window. Needs Chrome or Edge on HTTPS.
//
// The barcode scanner can be plugged into the same tablet and is also a WebUSB device, so the printer is chosen
// on purpose ("Connect printer") and remembered by its own USB IDs. A device that is the saved scanner is never
// used as the printer, so a print job can no longer be sent to the scanner.

/** The small part of the WebUSB API used here (the DOM typings do not always include it). */
interface UsbEndpoint {
  endpointNumber: number;
  direction: "in" | "out";
  type: "bulk" | "interrupt" | "isochronous";
}
interface UsbInterface {
  interfaceNumber: number;
  alternates: { interfaceClass?: number; endpoints: UsbEndpoint[] }[];
}
interface UsbDevice {
  vendorId: number;
  productId: number;
  productName?: string;
  opened: boolean;
  configuration: { interfaces: UsbInterface[] } | null;
  open(): Promise<void>;
  close(): Promise<void>;
  selectConfiguration(value: number): Promise<void>;
  claimInterface(n: number): Promise<void>;
  releaseInterface(n: number): Promise<void>;
  transferOut(endpoint: number, data: BufferSource): Promise<{ status: string }>;
}
interface UsbApi extends EventTarget {
  getDevices(): Promise<UsbDevice[]>;
  requestDevice(options: { filters: object[] }): Promise<UsbDevice>;
}

const CHUNK = 4096;

function usbApi(): UsbApi | null {
  return (navigator as unknown as { usb?: UsbApi }).usb ?? null;
}

/** A phone or a tablet (Android, iPhone, iPad), as opposed to a PC. */
export function isMobileDevice(): boolean {
  const nav = navigator as Navigator & { userAgentData?: { mobile?: boolean } };
  if (nav.userAgentData?.mobile) return true;
  const ua = nav.userAgent || "";
  if (/Android|iPhone|iPad|iPod/i.test(ua)) return true;
  // iPadOS pretends to be a Mac; a Mac with a touch screen is an iPad.
  return /Macintosh/.test(ua) && nav.maxTouchPoints > 1;
}

/** Print over USB on a phone or tablet whose browser can do it. Everyone else gets the PDF. */
export function detectUsbMode(): boolean {
  return isMobileDevice() && usbApi() !== null;
}

/** False on the server and on the first render, then true on a phone or tablet that can print over USB. */
export function useUsbMode(): boolean {
  const [usb, setUsb] = useState(false);
  useEffect(() => setUsb(detectUsbMode()), []);
  return usb;
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

const NOT_THE_SCANNER = "That is the barcode scanner. Pick the label printer.";

/**
 * True for a USB serial (CDC) device that is not a printer: that is how this barcode scanner shows up, and it also
 * has an output endpoint, so a print job sent to it is silently swallowed. A label printer has the USB printer
 * class (7) or a vendor class. Opens the device briefly to read its interfaces, which does not claim anything.
 */
async function looksLikeScanner(device: UsbDevice): Promise<boolean> {
  // Name and saved ID only: the device is never opened just to look at it.
  return isSavedUsb(SCANNER_KEY, device) || /decoder|scanner|barcode/i.test(device.productName ?? "");
}

/** Opens the browser's device picker, refuses the scanner, and remembers the printer that was picked. */
async function chooseNewPrinter(usb: UsbApi): Promise<UsbDevice> {
  // No filter: the list shows every USB device and the user picks the printer.
  const device = await usb.requestDevice({ filters: [] });
  if (await looksLikeScanner(device)) throw new Error(NOT_THE_SCANNER);
  saveUsb(PRINTER_KEY, device);
  return device;
}

async function pickPrinter(usb: UsbApi): Promise<UsbDevice> {
  // The printer the person connected is found again without asking. Nothing else is guessed: a tablet that has
  // allowed the scanner too would otherwise hand the print job to whichever device came first.
  const known = await usb.getDevices();
  const saved = known.find((d) => isSavedUsb(PRINTER_KEY, d));
  // A wrongly saved scanner (picked as the printer earlier) is dropped so the picker opens again.
  if (saved && !(await looksLikeScanner(saved))) return saved;
  return chooseNewPrinter(usb);
}

/**
 * Lets the person pick the label printer (or pick a different one) and remembers it. Call it straight from a tap:
 * the browser only shows its device picker right after one.
 */
export async function connectPrinter(): Promise<void> {
  const usb = usbApi();
  if (!usb) throw new Error("This browser cannot print over USB. Use Chrome or Edge.");
  await chooseNewPrinter(usb);
}

async function send(device: UsbDevice, text: string) {
  if (await looksLikeScanner(device)) throw new Error(NOT_THE_SCANNER);
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
 * Fetches the printer commands from each address (the sign-in cookie goes along) and sends them to the printer in
 * one job. Call it straight from a tap: the first time, the browser shows its printer picker and only allows that
 * right after a tap, so the printer is chosen before anything is fetched.
 */
export async function printTsplUrls(urls: string[]): Promise<void> {
  const usb = usbApi();
  if (!usb) throw new Error("This browser cannot print over USB. Use Chrome or Edge.");
  const device = await pickPrinter(usb);
  const parts: string[] = [];
  for (const url of urls) {
    const res = await fetch(url, { credentials: "same-origin", cache: "no-store" });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(body?.error ?? `Could not get the labels (${res.status}).`);
    }
    parts.push(await res.text());
  }
  await send(device, parts.join(""));
}

/**
 * Whether a printer is connected, its name, and a `connect` that opens the picker. The state follows the printer
 * being plugged in or unplugged. Only meaningful on a phone or tablet (`usbMode`); elsewhere it stays empty.
 */
export function usePrinterConnection() {
  const usbMode = useUsbMode();
  const [connected, setConnected] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    const usb = usbApi();
    if (!usb) return;
    try {
      const devices = await usb.getDevices();
      // A scanner that was wrongly saved as the printer earlier is forgotten.
      const wrong = devices.find((d) => isSavedUsb(PRINTER_KEY, d) && /decoder|scanner|barcode/i.test(d.productName ?? ""));
      if (wrong) window.localStorage.removeItem(PRINTER_KEY);
      const printer = devices.find(
        (d) => isSavedUsb(PRINTER_KEY, d) && !/decoder|scanner|barcode/i.test(d.productName ?? ""),
      );
      setConnected(!!printer);
      setName(printer?.productName ?? "");
    } catch {
      setConnected(false);
    }
  }, []);

  useEffect(() => {
    if (!usbMode) return;
    const usb = usbApi();
    if (!usb) return;
    void refresh();
    usb.addEventListener("connect", refresh);
    usb.addEventListener("disconnect", refresh);
    return () => {
      usb.removeEventListener("connect", refresh);
      usb.removeEventListener("disconnect", refresh);
    };
  }, [usbMode, refresh]);

  const connect = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      await connectPrinter();
      await refresh();
    } catch (err) {
      // Closing the picker without choosing is not an error worth showing.
      if (!isPickerCancel(err)) setError(usbErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  return { usbMode, connected, name, busy, error, connect };
}

/** Chrome's message when the picker is closed without choosing a device. Other NotFoundErrors are real failures. */
const isPickerCancel = (err: unknown): boolean =>
  err instanceof Error && err.name === "NotFoundError" && /no device selected/i.test(err.message);

/** A sentence a person can act on, for whatever went wrong. */
export function usbErrorMessage(err: unknown): string {
  const name = err instanceof Error ? err.name : "";
  if (isPickerCancel(err)) return "No printer was chosen.";
  if (name === "NotFoundError") {
    return `Chrome lost the printer after you chose it. Unplug and replug it, tap Connect, and allow USB access if Android asks. (${(err as Error).message})`;
  }
  if (name === "SecurityError" || name === "NetworkError") {
    return `Chrome could not open the printer. Unplug and replug it, then try again. (${(err as Error).message})`;
  }
  return err instanceof Error ? err.message : "Printing failed.";
}
