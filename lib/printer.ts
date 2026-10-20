// Sends ZPL straight to a networked Zebra-class printer (raw TCP, port 9100 by default).
import { Socket } from "node:net";

/** Accepts "192.168.1.50" or "192.168.1.50:9100". */
export function parsePrinterHost(value: string): { host: string; port: number } {
  const trimmed = value.trim();
  const match = /^(.+?)(?::(\d{1,5}))?$/.exec(trimmed);
  if (!match || !match[1]) throw new Error(`PRINTER_HOST "${value}" is not a valid host`);
  const port = match[2] ? Number(match[2]) : 9100;
  if (port < 1 || port > 65535) throw new Error(`PRINTER_HOST "${value}" has an invalid port`);
  return { host: match[1], port };
}

export function sendToPrinter(printerHost: string, zpl: string, timeoutMs = 8000): Promise<void> {
  const { host, port } = parsePrinterHost(printerHost);
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (err) reject(err);
      else resolve();
    };
    socket.setTimeout(timeoutMs, () => finish(new Error(`The printer at ${host}:${port} did not respond`)));
    socket.once("error", (err) => finish(new Error(`Could not reach the printer at ${host}:${port}: ${err.message}`)));
    socket.connect(port, host, () => {
      socket.end(zpl, "utf8", () => finish());
    });
  });
}
