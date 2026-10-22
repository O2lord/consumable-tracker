// Client-side printing for the label printer. Used by every button that prints straight to the label printer.
//
// Two ways to reach the USB printer, tried in this order:
//   1. QZ Tray (https://qz.io) running on this computer.
//   2. The print helper (scripts/print_bridge.py) running on this computer, on ws://localhost:8767.
//
// The helper is used only when QZ Tray cannot be reached. If QZ Tray is running and the print itself fails, the
// error is shown and the job is NOT retried on the helper, so a label can never print twice.

const BRIDGE_URL = "ws://localhost:8767";
const BRIDGE_DOWN =
  "The print helper is not running on this computer. Ask whoever manages this PC to run the print helper installer (scripts/print-helper), or restart the PC if it was installed already.";

// Part of the label printer's name. Spaces, dashes and underscores are ignored when matching, so
// "Xprinter_XP_365B_2" (Mac) and "Xprinter XP-365B" (Windows) both match.
const PRINTER_MATCH = "Xprinter_XP_365B";

// QZ Tray's browser library, pinned to an exact version.
const QZ_SCRIPT_URL = "https://cdn.jsdelivr.net/npm/qz-tray@2.2.4/qz-tray.js";
const QZ_CONNECT_TIMEOUT_MS = 60_000; // long enough for a person to click Allow on QZ's popup (a missing QZ fails instantly)
const QZ_RETRY_AFTER_MS = 30_000;

// ---- QZ Tray ----

type QzPrintData = { type: "raw"; format: "command"; flavor: "plain"; data: string };
type QzHandler = (resolve: (value: string) => void, reject: (reason?: unknown) => void) => void;
type QzApi = {
  websocket: {
    isActive(): boolean;
    connect(options?: { retries?: number; delay?: number; usingSecure?: boolean }): Promise<void>;
  };
  security: {
    setCertificatePromise(handler: QzHandler): void;
    setSignatureAlgorithm(algorithm: string): void;
    setSignaturePromise(handler: (toSign: string) => QzHandler): void;
  };
  printers: { find(query?: string): Promise<string | string[]>; getDefault(): Promise<string> };
  configs: { create(printer: string, options?: Record<string, unknown>): unknown };
  print(config: unknown, data: QzPrintData[]): Promise<void>;
};

/** Thrown when QZ Tray is reachable but the print itself failed. Never falls back to the helper. */
class QzPrintError extends Error {}

let qzScript: Promise<QzApi> | null = null;
let qzDownUntil = 0;

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function loadQzLibrary(): Promise<QzApi> {
  if (typeof window === "undefined") return Promise.reject(new Error("QZ Tray is only available in the browser"));
  const existing = (window as unknown as { qz?: QzApi }).qz;
  if (existing) return Promise.resolve(existing);
  if (!qzScript) {
    qzScript = new Promise<QzApi>((resolve, reject) => {
      const tag = document.createElement("script");
      tag.src = QZ_SCRIPT_URL;
      tag.async = true;
      tag.onload = () => {
        const qz = (window as unknown as { qz?: QzApi }).qz;
        if (qz) resolve(qz);
        else reject(new Error("The QZ Tray library did not load"));
      };
      tag.onerror = () => reject(new Error("The QZ Tray library could not be downloaded"));
      document.head.appendChild(tag);
    }).catch((err) => {
      qzScript = null; // allow another try next time
      throw err;
    });
  }
  return qzScript;
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function normalise(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Signs the requests to QZ Tray with the app's certificate (see /api/qz/sign and scripts/qz/README.md), so QZ Tray
 * can remember "Allow". When the server has no signing set up, the certificate request fails and QZ Tray treats
 * the requests as anonymous, as before.
 */
let signingConfigured = false;
function setupQzSigning(qz: QzApi): void {
  if (signingConfigured) return;
  signingConfigured = true;
  qz.security.setSignatureAlgorithm("SHA512");
  qz.security.setCertificatePromise((resolve, reject) => {
    fetch("/api/qz/certificate", { cache: "no-store", credentials: "same-origin" })
      .then((res) => (res.ok ? res.text() : Promise.reject(new Error("No QZ certificate"))))
      .then(resolve, reject);
  });
  qz.security.setSignaturePromise((toSign) => (resolve, reject) => {
    fetch("/api/qz/sign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      credentials: "same-origin",
      body: JSON.stringify({ request: toSign }),
    })
      .then((res) => (res.ok ? res.text() : Promise.reject(new Error("Could not sign the QZ request"))))
      .then(resolve, reject);
  });
}

/** Connects to QZ Tray. Rejects (quickly) when it is not running, which means "use the helper instead". */
async function connectQz(): Promise<QzApi> {
  const qz = await loadQzLibrary();
  setupQzSigning(qz);
  if (!qz.websocket.isActive()) {
    // Secure (wss) only: QZ Tray's plain ws ports are refused by current versions, and the page is often served
    // over https, where only wss is allowed anyway. Allow a little longer than before, because the first wss
    // handshake can be slow.
    await withTimeout(
      qz.websocket.connect({ retries: 0, delay: 0, usingSecure: true }),
      QZ_CONNECT_TIMEOUT_MS,
      "QZ Tray did not answer",
    );
  }
  return qz;
}

async function sendToQz(qz: QzApi, tspl: string): Promise<number> {
  try {
    const found = await qz.printers.find();
    const printers = Array.isArray(found) ? found : [found];
    const wanted = normalise(PRINTER_MATCH);
    const matches = printers.filter((name) => normalise(name).includes(wanted));
    // A PC can have several queues for the same printer (for example "Xprinter_XP_365B" and "Xprinter_XP_365B_2"),
    // and only the one set up for raw label commands prints correctly. That is the one the PC uses as its default
    // printer, so prefer it. Otherwise take the first match.
    let printer = matches[0];
    if (matches.length > 1) {
      try {
        const fallback = await qz.printers.getDefault();
        if (matches.includes(fallback)) printer = fallback;
      } catch {
        // no default printer set: keep the first match
      }
    }
    if (!printer) {
      throw new Error(`QZ Tray is running but no printer named like "${PRINTER_MATCH}" was found. Check that the label printer is plugged in and switched on.`);
    }
    // forceRaw (called altPrinting before QZ 2.2) makes QZ send the commands to the print queue as raw data on
    // macOS/Linux. Without it CUPS can treat them as text and print the commands themselves on the label.
    await qz.print(qz.configs.create(printer, { forceRaw: true, altPrinting: true }), [
      { type: "raw", format: "command", flavor: "plain", data: tspl },
    ]);
    return (tspl.match(/^\s*PRINT\b/gim) ?? []).length;
  } catch (err) {
    throw new QzPrintError(`Printing through QZ Tray failed: ${errorText(err)}`);
  }
}

// ---- print helper (scripts/print_bridge.py) ----

function sendToHelper(tspl: string): Promise<number> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let socket: WebSocket;
    const finish = (err?: Error, labels = 0) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket?.close();
      if (err) reject(err);
      else resolve(labels);
    };
    const timer = setTimeout(() => finish(new Error("The print helper did not answer. Check the printer and try again.")), 15000);
    try {
      socket = new WebSocket(BRIDGE_URL);
    } catch {
      finish(new Error(BRIDGE_DOWN));
      return;
    }
    socket.onopen = () => socket.send(JSON.stringify({ type: "print", tspl }));
    socket.onerror = () => finish(new Error(BRIDGE_DOWN));
    socket.onclose = () => finish(new Error(BRIDGE_DOWN));
    socket.onmessage = (event) => {
      try {
        const reply = JSON.parse(String(event.data)) as { type?: string; labels?: number; message?: string };
        if (reply.type === "printed") finish(undefined, reply.labels ?? 0);
        else finish(new Error(reply.message ?? "Printing failed"));
      } catch {
        finish(new Error("The print helper gave an answer that could not be read"));
      }
    };
  });
}

// ---- public entry point ----

/** Sends the label commands to the printer and resolves with how many labels it printed. */
export async function sendToBridge(tspl: string): Promise<number> {
  let qzReason = "";

  if (Date.now() >= qzDownUntil) {
    let qz: QzApi | null = null;
    try {
      qz = await connectQz();
    } catch (err) {
      qzDownUntil = Date.now() + QZ_RETRY_AFTER_MS; // skip the wait on the next labels while QZ Tray is down
      qzReason = errorText(err);
    }
    // QZ Tray is reachable: its result is final, whether it printed or failed. No retry on the helper.
    if (qz) return sendToQz(qz, tspl);
  } else {
    qzReason = "QZ Tray was not reachable a moment ago";
  }

  try {
    return await sendToHelper(tspl);
  } catch (err) {
    throw new Error(`QZ Tray is not available (${qzReason}) and the print helper failed: ${errorText(err)}`);
  }
}
