// Client-side helper for the print helper (scripts/print_bridge.py) that runs on the computer the label printer
// is plugged into. Used by every button that prints straight to the label printer.

const BRIDGE_URL = "ws://localhost:8767";
const BRIDGE_DOWN =
  "The print helper is not running on this computer. Ask whoever manages this PC to run the print helper installer (scripts/print-helper), or restart the PC if it was installed already.";

/** Sends the label commands to the print helper and resolves with how many labels it printed. */
export function sendToBridge(tspl: string): Promise<number> {
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
