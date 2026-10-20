// Sends ZPL straight to a networked Zebra-class printer (raw TCP, port 9100 by default).
import { spawn } from "node:child_process";
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

/**
 * Sends raw printer commands to a printer queue on this computer (a USB printer), with `lp -o raw`.
 * Raw means the driver does not turn it into a page: the printer reads the commands itself.
 * Find the queue name with `lpstat -p`, for example "Xprinter_XP_365B_2".
 */
export function sendToQueue(queue: string, data: string, timeoutMs = 10000): Promise<void> {
  if (!/^[A-Za-z0-9_.-]+$/.test(queue)) {
    return Promise.reject(new Error(`PRINTER_QUEUE "${queue}" is not a valid queue name`));
  }
  return new Promise((resolve, reject) => {
    const child = spawn("lp", ["-d", queue, "-o", "raw"], { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error(`The printer queue ${queue} did not accept the job`));
    }, timeoutMs);
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", (err) => finish(new Error(`Could not run lp for queue ${queue}: ${err.message}`)));
    child.once("close", (code) => {
      if (code === 0) finish();
      else finish(new Error(`lp failed for queue ${queue}: ${stderr.trim() || `exit code ${code}`}`));
    });
    child.stdin.end(Buffer.from(data, "latin1"));
  });
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
