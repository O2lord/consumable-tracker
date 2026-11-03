"use client";

import { useEffect, useState } from "react";

// Printing straight to a USB label printer (such as the Xprinter XP-365B) from the browser, over WebUSB.
// Phones and tablets cannot use the printer driver a PC uses, so there the page sends the printer its own
// commands (TSPL) instead of a PDF. A PC keeps the PDF and the system print window. Needs Chrome or Edge on HTTPS.

/** The small part of the WebUSB API used here (the DOM typings do not always include it). */
interface UsbEndpoint {
  endpointNumber: number;
  direction: "in" | "out";
  type: "bulk" | "interrupt" | "isochronous";
}
interface UsbInterface {
  interfaceNumber: number;
  alternates: { endpoints: UsbEndpoint[] }[];
}
interface UsbDevice {
  opened: boolean;
  configuration: { interfaces: UsbInterface[] } | null;
  open(): Promise<void>;
  selectConfiguration(value: number): Promise<void>;
  claimInterface(n: number): Promise<void>;
  releaseInterface(n: number): Promise<void>;
  transferOut(endpoint: number, data: BufferSource): Promise<{ status: string }>;
}
interface UsbApi {
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

async function pickPrinter(usb: UsbApi): Promise<UsbDevice> {
  // A printer the user already allowed on this site is found again without asking.
  const known = await usb.getDevices();
  if (known.length === 1) return known[0];
  // No filter: the list shows every USB device and the user picks the printer.
  return usb.requestDevice({ filters: [] });
}

async function send(device: UsbDevice, text: string) {
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

/** A sentence a person can act on, for whatever went wrong. */
export function usbErrorMessage(err: unknown): string {
  const name = err instanceof Error ? err.name : "";
  if (name === "NotFoundError") return "No printer was chosen.";
  if (name === "SecurityError" || name === "NetworkError") {
    return "Chrome could not open the printer. Unplug and replug it, then try again.";
  }
  return err instanceof Error ? err.message : "Printing failed.";
}
