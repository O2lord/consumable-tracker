"""
print_bridge.py

Runs on the computer that has the label printer plugged in (USB). The deployed app cannot reach a USB
printer from the server, so the browser on this computer sends the label commands to this script over a
local WebSocket, and the script passes them to the printer as raw TSPL:

    browser (app page)  --ws://localhost:8767-->  print_bridge.py  -->  printer (USB)

Request:   { "type": "print", "tspl": "SIZE 50 mm,22 mm\\r\\n...PRINT 1,1\\r\\n" }
Reply:     { "type": "printed", "labels": 2 }   or   { "type": "error", "message": "..." }

components/.../PrintButton.tsx talks to it. Same idea as scanner_bridge.py: it only listens on localhost.

Safety:
  * Only pages from an allowed origin may connect (see --origin). Any other website is refused, so a random
    web page cannot print on your printer.
  * Only plain label commands are passed on (SIZE, GAP, DIRECTION, REFERENCE, CLS, TEXT, BARCODE, PRINT).
    Anything else is refused.

Setup (once):
    pip3 install websockets
    Windows also needs:  pip install pywin32

Run (macOS / Linux: the printer queue name comes from `lpstat -p`; Windows: the name in Printers & scanners):
    python3 scripts/print_bridge.py --printer Xprinter_XP_365B_2 --origin https://your-app.example.com
    python3 scripts/print_bridge.py --list        # list printers and exit

Leave --printer out to use the computer's default printer. http://localhost:3000 is always allowed, for
running the app on this computer.
"""

import argparse
import asyncio
import json
import logging
import os
import subprocess
import sys
from typing import List, Optional

# The browser sends the app's cookies (shared by every localhost port) with the WebSocket handshake, and they can
# pass websockets' default 8192-byte header line limit, which makes the handshake fail. Raise it before websockets
# is imported (newer versions read the environment variable).
os.environ.setdefault("WEBSOCKETS_MAX_LINE_LENGTH", "65536")

import websockets

try:  # older versions use a module constant instead
    import websockets.http11 as _http11

    if hasattr(_http11, "MAX_LINE_LENGTH"):
        _http11.MAX_LINE_LENGTH = 65536
except ImportError:
    pass

# Started at login with no console window (pythonw on Windows), there is no stderr, so log to a file instead.
_log_target = {} if sys.stderr else {"filename": os.path.join(os.path.expanduser("~"), "print_helper.log")}
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", **_log_target)
log = logging.getLogger("print_bridge")

WS_HOST = "localhost"
WS_PORT = 8767  # 8765 is nfc_bridge.py, 8766 is scanner_bridge.py
MAX_BYTES = 512 * 1024

# The label commands the app sends. Anything else (downloads, resets, firmware commands) is refused.
ALLOWED_COMMANDS = {"SIZE", "GAP", "DIRECTION", "REFERENCE", "CLS", "TEXT", "BARCODE", "PRINT"}


def check_tspl(tspl: str) -> int:
    """Raises ValueError when the job holds anything but plain label commands. Returns the label count."""
    labels = 0
    for line in tspl.replace("\r\n", "\n").split("\n"):
        line = line.strip()
        if not line:
            continue
        command = line.split(" ", 1)[0].upper()
        if command not in ALLOWED_COMMANDS:
            raise ValueError(f"Command not allowed: {command}")
        if command == "PRINT":
            labels += 1
    if labels == 0:
        raise ValueError("The job has no labels")
    return labels


def send_raw(printer: Optional[str], data: bytes) -> None:
    """Sends the bytes to the printer without letting the driver turn them into a page."""
    if sys.platform == "win32":
        import win32print  # pip install pywin32

        name = printer or win32print.GetDefaultPrinter()
        handle = win32print.OpenPrinter(name)
        try:
            win32print.StartDocPrinter(handle, 1, ("Labels", None, "RAW"))
            try:
                win32print.StartPagePrinter(handle)
                win32print.WritePrinter(handle, data)
                win32print.EndPagePrinter(handle)
            finally:
                win32print.EndDocPrinter(handle)
        finally:
            win32print.ClosePrinter(handle)
        return

    command = ["lp", "-o", "raw"]
    if printer:
        command[1:1] = ["-d", printer]
    result = subprocess.run(command, input=data, capture_output=True, timeout=15)
    if result.returncode != 0:
        raise RuntimeError(result.stderr.decode(errors="replace").strip() or f"lp exited with {result.returncode}")


def list_printers() -> None:
    if sys.platform == "win32":
        import win32print

        for flags, _desc, name, _comment in win32print.EnumPrinters(2):
            print(name)
    else:
        print(subprocess.run(["lpstat", "-p"], capture_output=True, text=True).stdout)


async def main(printer: Optional[str], origins: List[str], port: int) -> None:
    async def handle_client(websocket):
        log.info("App connected (%s)", websocket.request.headers.get("Origin") if hasattr(websocket, "request") else "")
        async for raw in websocket:
            try:
                message = json.loads(raw)
                if message.get("type") != "print":
                    raise ValueError("Unknown request")
                tspl = message.get("tspl")
                if not isinstance(tspl, str) or len(tspl) > MAX_BYTES:
                    raise ValueError("No label commands in the request")
                labels = check_tspl(tspl)
                await asyncio.to_thread(send_raw, printer, tspl.encode("ascii", errors="replace"))
                log.info("Printed %d label(s)", labels)
                await websocket.send(json.dumps({"type": "printed", "labels": labels}))
            except Exception as err:  # reported to the page, which shows it next to the button
                log.warning("Print failed: %s", err)
                await websocket.send(json.dumps({"type": "error", "message": str(err)}))

    async with websockets.serve(handle_client, WS_HOST, port, origins=origins, max_size=MAX_BYTES * 2):
        log.info("Print bridge on ws://%s:%d, printer: %s, allowed origins: %s", WS_HOST, port, printer or "(default)", ", ".join(origins))
        await asyncio.Future()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Passes label commands from the app to a USB label printer")
    parser.add_argument("--printer", help="printer queue (macOS/Linux, see lpstat -p) or printer name (Windows)")
    parser.add_argument(
        "--origin",
        action="append",
        default=[],
        help="address of the app allowed to print, e.g. https://tracker.example.com (repeat for several)",
    )
    parser.add_argument(
        "--extension-id",
        action="append",
        default=[],
        help="ID of the browser extension allowed to print (shown in the extension's print error), repeat for several",
    )
    parser.add_argument("--port", type=int, default=WS_PORT)
    parser.add_argument("--list", action="store_true", help="list printers and exit")
    args = parser.parse_args()

    if args.list:
        list_printers()
        sys.exit(0)

    allowed = ["http://localhost:3000", *args.origin, *[f"chrome-extension://{i}" for i in args.extension_id]]
    asyncio.run(main(args.printer, allowed, args.port))
