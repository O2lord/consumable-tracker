// The scanner and the label printer are both plain USB devices to a browser, and a tablet can have both plugged in.
// Each one the person picks is remembered here under its own key, so a page never mistakes one for the other.

export const SCANNER_KEY = "scanner-usb-id";
export const PRINTER_KEY = "printer-usb-id";

export interface SavedUsb {
  v: number;
  p: number;
}

export function readSavedUsb(key: string): SavedUsb | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as SavedUsb) : null;
  } catch {
    return null;
  }
}

export function saveUsb(key: string, d: { vendorId: number; productId: number }): void {
  try {
    window.localStorage.setItem(key, JSON.stringify({ v: d.vendorId, p: d.productId }));
  } catch {
    /* storage can be blocked */
  }
}

export function isSavedUsb(key: string, d: { vendorId: number; productId: number }): boolean {
  const saved = readSavedUsb(key);
  return !!saved && d.vendorId === saved.v && d.productId === saved.p;
}
