"""
scanner_bridge.py

Runs on a Mac whose USB barcode scanner beeps but types nothing (macOS drops the keystrokes of
scanners that do not report a keyboard layout). It reads the scanner's raw HID reports directly,
turns the keycodes into characters, treats Enter as "end of scan", and broadcasts each scan to the
browser over a local WebSocket:

    { "type": "scan", "code": "ABC123" }

components/scanner/ScanInput.tsx listens on ws://localhost:8766 and treats a message like a scan
typed into the field. If this script is not running, ScanInput behaves exactly as before.

Only run this where the scanner does not type on its own. Where it does (Windows, or a Mac that
accepts it), typing already works and running the bridge as well would submit each scan twice.

Setup (once):
    pip3 install hidapi websockets

macOS permission: System Settings > Privacy & Security > Input Monitoring, add the app you run this
from (Terminal or VS Code) and turn it on, then quit and reopen that app.

Run:
    python3 scripts/scanner_bridge.py            # LICON LP1010 (DECODER-KEYBOARD) by default
    python3 scripts/scanner_bridge.py --debug    # also print every raw HID report, for diagnosis
    python3 scripts/scanner_bridge.py --list     # list HID devices and exit
"""

import argparse
import asyncio
import json
import logging
import os
import threading
import time
from typing import Dict, List, Optional, Set

# The browser sends its localhost cookies (the app's login cookies, shared across ports) with the
# WebSocket handshake, which can exceed websockets' default 8192-byte header line limit. Raise it
# before websockets is imported (newer versions read the environment variable).
os.environ.setdefault("WEBSOCKETS_MAX_LINE_LENGTH", "65536")

import hid
import websockets

try:  # older versions use a module constant instead
    import websockets.http11 as _http11

    if hasattr(_http11, "MAX_LINE_LENGTH"):
        _http11.MAX_LINE_LENGTH = 65536
except ImportError:
    pass

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("scanner_bridge")

WS_HOST = "localhost"
WS_PORT = 8766  # 8765 is nfc_bridge.py

VENDOR_ID = 0x1D82
PRODUCT_ID = 0x5CA0

# USB HID usage IDs (keyboard page 0x07) -> (unshifted, shifted).
KEYMAP: Dict[int, tuple] = {}
for i, ch in enumerate("abcdefghijklmnopqrstuvwxyz"):
    KEYMAP[0x04 + i] = (ch, ch.upper())
for i, (n, s) in enumerate(zip("1234567890", "!@#$%^&*()")):
    KEYMAP[0x1E + i] = (n, s)
KEYMAP.update(
    {
        0x2C: (" ", " "),
        0x2D: ("-", "_"),
        0x2E: ("=", "+"),
        0x2F: ("[", "{"),
        0x30: ("]", "}"),
        0x31: ("\\", "|"),
        0x33: (";", ":"),
        0x34: ("'", '"'),
        0x35: ("`", "~"),
        0x36: (",", "<"),
        0x37: (".", ">"),
        0x38: ("/", "?"),
        0x54: ("/", "/"),  # keypad
        0x55: ("*", "*"),
        0x56: ("-", "-"),
        0x57: ("+", "+"),
    }
)
for i, ch in enumerate("1234567890"):  # keypad digits 1-9, 0
    KEYMAP[0x59 + i] = (ch, ch)
KEYMAP[0x63] = (".", ".")

ENTER_KEYS = {0x28, 0x58}  # Return, keypad Enter
TAB_KEY = 0x2B
SHIFT_BITS = 0x02 | 0x20  # left shift, right shift
CAPS_LOCK = 0x39

connected_clients: Set = set()
main_loop: Optional[asyncio.AbstractEventLoop] = None
debug = False
no_open = False  # diagnostic: watch match/remove only, never open the device
exclusive = True  # seize the scanner so macOS does not also type its keystrokes into the page


async def broadcast(message: dict):
    if not connected_clients:
        log.info("Scan read but no browser tab connected, dropping: %s", message)
        return
    payload = json.dumps(message)
    await asyncio.gather(*[c.send(payload) for c in list(connected_clients)], return_exceptions=True)


def emit_scan(code: str):
    log.info("Scan: %s", code)
    if main_loop is not None:
        asyncio.run_coroutine_threadsafe(broadcast({"type": "scan", "code": code}), main_loop)


class ReportDecoder:
    """Turns a stream of boot-keyboard HID reports into finished scans."""

    def __init__(self):
        self.buffer: List[str] = []
        self.held: Set[int] = set()
        self.last_activity = time.monotonic()
        self.shift_keys: Set[int] = set()

    def feed_key(self, usage: int, down: bool):
        """Key-by-key input (used by the IOKit reader): usage is the HID keyboard-page code."""
        now = time.monotonic()
        if self.buffer and now - self.last_activity > 2.0:
            self.buffer.clear()
        self.last_activity = now
        if usage in (0xE1, 0xE5):  # left / right shift
            if down:
                self.shift_keys.add(usage)
            else:
                self.shift_keys.discard(usage)
            return
        if not down:
            return
        if usage in ENTER_KEYS or usage == TAB_KEY:
            self.finish()
        elif usage in KEYMAP:
            self.buffer.append(KEYMAP[usage][1 if self.shift_keys else 0])

    def feed(self, report: List[int]):
        data = list(report)
        # Boot keyboard report: [modifiers, reserved, key1..key6] = 8 bytes.
        # A 9-byte report carries a leading report ID, which we drop.
        if len(data) == 9:
            data = data[1:]
        if len(data) < 3:
            return

        # A long pause means a stale partial scan; start fresh.
        now = time.monotonic()
        if self.buffer and now - self.last_activity > 2.0:
            self.buffer.clear()
        self.last_activity = now

        modifiers = data[0]
        shift = bool(modifiers & SHIFT_BITS)
        keys = {k for k in data[2:8] if k not in (0, 1)}  # 1 = rollover error
        pressed = keys - self.held
        self.held = keys

        for key in sorted(pressed):
            if key in ENTER_KEYS:
                self.finish()
            elif key == TAB_KEY:
                self.finish()
            elif key in KEYMAP:
                self.buffer.append(KEYMAP[key][1 if shift else 0])

    def finish(self):
        code = "".join(self.buffer).strip()
        self.buffer.clear()
        if code:
            emit_scan(code)


def find_paths(vendor_id: int, product_id: int) -> List[bytes]:
    """Only the keyboard interface (usage page 1, usage 6) carries scans. The scanner also exposes a
    vendor-defined interface (usage page 0xFFA0) used for configuration, which we leave alone."""
    paths = []
    for info in hid.enumerate(vendor_id, product_id):
        if info.get("usage_page") == 1 and info.get("usage") == 6:
            paths.append(info["path"])
    return paths


def allow_shared_open():
    """macOS: by default hidapi tries to seize the device exclusively, which is refused for keyboards
    unless running as root. Ask for a shared (non-exclusive) open when this build of hidapi supports it."""
    for name in ("hid_darwin_set_open_exclusive", "darwin_set_open_exclusive"):
        fn = getattr(hid, name, None)
        if fn:
            fn(0)
            log.info("Using shared (non-exclusive) HID open")
            return
    log.info("This hidapi build cannot set shared open; if opening fails, run the bridge with sudo")


def read_device(path: bytes):
    """Reads one HID interface until it fails, then returns so the caller can retry."""
    dev = hid.device()
    try:
        dev.open_path(path)
    except OSError as exc:
        log.error(
            "Could not open scanner keyboard interface (%s). Try: sudo python3 scripts/scanner_bridge.py --debug",
            exc,
        )
        time.sleep(10)  # slow the retry so the log is not flooded
        return
    log.info("Opened scanner interface %s", path)
    decoder = ReportDecoder()
    try:
        while True:
            report = dev.read(64, timeout_ms=500)
            if not report:
                continue
            if debug:
                log.info("raw report: %s", " ".join(f"{b:02x}" for b in report))
            decoder.feed(report)
    except OSError as exc:
        log.warning("Scanner read failed (%s); will retry", exc)
    finally:
        dev.close()


def run_iokit_reader(vendor_id: int, product_id: int):
    """Reads the scanner through macOS IOHIDManager WITHOUT seizing it (no exclusive open), so macOS
    has no reason to tear the HID connection down. IOHIDManager also handles unplug/replug itself.
    Needs Input Monitoring permission for the app you run this from (or sudo)."""
    import ctypes

    vp = ctypes.c_void_p
    cf = ctypes.CDLL("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")
    iokit = ctypes.CDLL("/System/Library/Frameworks/IOKit.framework/IOKit")

    cf.CFStringCreateWithCString.restype = vp
    cf.CFStringCreateWithCString.argtypes = [vp, ctypes.c_char_p, ctypes.c_uint32]
    cf.CFNumberCreate.restype = vp
    cf.CFNumberCreate.argtypes = [vp, ctypes.c_int, vp]
    cf.CFDictionaryCreateMutable.restype = vp
    cf.CFDictionaryCreateMutable.argtypes = [vp, ctypes.c_long, vp, vp]
    cf.CFDictionarySetValue.argtypes = [vp, vp, vp]
    cf.CFRunLoopGetCurrent.restype = vp
    iokit.IOHIDManagerCreate.restype = vp
    iokit.IOHIDManagerCreate.argtypes = [vp, ctypes.c_uint32]
    iokit.IOHIDManagerSetDeviceMatching.argtypes = [vp, vp]
    iokit.IOHIDManagerRegisterInputValueCallback.argtypes = [vp, vp, vp]
    iokit.IOHIDManagerScheduleWithRunLoop.argtypes = [vp, vp, vp]
    iokit.IOHIDManagerOpen.restype = ctypes.c_int32
    iokit.IOHIDManagerOpen.argtypes = [vp, ctypes.c_uint32]
    iokit.IOHIDValueGetElement.restype = vp
    iokit.IOHIDValueGetElement.argtypes = [vp]
    iokit.IOHIDElementGetUsagePage.restype = ctypes.c_uint32
    iokit.IOHIDElementGetUsagePage.argtypes = [vp]
    iokit.IOHIDElementGetUsage.restype = ctypes.c_uint32
    iokit.IOHIDElementGetUsage.argtypes = [vp]
    iokit.IOHIDValueGetIntegerValue.restype = ctypes.c_long
    iokit.IOHIDValueGetIntegerValue.argtypes = [vp]
    iokit.IOHIDDeviceGetProperty.restype = vp
    iokit.IOHIDDeviceGetProperty.argtypes = [vp, vp]
    cf.CFNumberGetValue.restype = ctypes.c_ubyte
    cf.CFNumberGetValue.argtypes = [vp, ctypes.c_int, vp]

    def cfstr(text: str):
        return cf.CFStringCreateWithCString(None, text.encode(), 0x08000100)  # UTF-8

    keep = []  # keeps ctypes objects alive for as long as the reader runs

    def cfnum(value: int):
        num = ctypes.c_int32(value)
        keep.append(num)
        return cf.CFNumberCreate(None, 3, ctypes.addressof(num))  # 3 = kCFNumberSInt32Type

    key_cb = ctypes.addressof(ctypes.c_char.in_dll(cf, "kCFTypeDictionaryKeyCallBacks"))
    val_cb = ctypes.addressof(ctypes.c_char.in_dll(cf, "kCFTypeDictionaryValueCallBacks"))
    match = cf.CFDictionaryCreateMutable(None, 0, key_cb, val_cb)
    for name, value in (
        ("VendorID", vendor_id),
        ("ProductID", product_id),
        ("DeviceUsagePage", 1),  # keyboard interface only, not the vendor-defined config one
        ("DeviceUsage", 6),
    ):
        cf.CFDictionarySetValue(match, cfstr(name), cfnum(value))

    decoder = ReportDecoder()

    @ctypes.CFUNCTYPE(None, vp, ctypes.c_int32, vp, vp)
    def on_value(context, result, sender, value):
        try:
            element = iokit.IOHIDValueGetElement(value)
            page = iokit.IOHIDElementGetUsagePage(element)
            usage = iokit.IOHIDElementGetUsage(element)
            raw = iokit.IOHIDValueGetIntegerValue(value)
            if debug:
                log.info("value page=0x%x usage=0x%x value=%d", page, usage, raw)
            # Not decoded here: macOS delivers a key before its Shift state in this callback, which
            # would lose capitals. on_report below decodes the raw reports, where modifiers come first.
        except Exception:
            log.exception("Error handling HID value")

    last_event = {"matched": None, "reports": 0}

    def device_ids(device) -> str:
        """LocationID is the USB port path: if it is the same after a remove/match, macOS re-enumerated
        the device on the same port; if it changes, the USB device really disconnected and came back."""

        def prop(key: str):
            try:
                ref = iokit.IOHIDDeviceGetProperty(device, cfstr(key))
                if not ref:
                    return None
                out = ctypes.c_int64()
                if cf.CFNumberGetValue(ref, 4, ctypes.byref(out)):  # 4 = kCFNumberSInt64Type
                    return out.value
            except Exception:
                pass
            return None

        loc = prop("LocationID")
        uid = prop("UniqueID")
        ver = prop("VersionNumber")
        usage = prop("PrimaryUsage")
        return (
            f"LocationID={'0x%08x' % loc if loc is not None else '?'} "
            f"UniqueID={uid if uid is not None else '?'} "
            f"PrimaryUsage={usage if usage is not None else '?'} "
            f"Version={ver if ver is not None else '?'} device=0x{device or 0:x}"
        )

    @ctypes.CFUNCTYPE(None, vp, ctypes.c_int32, vp, vp)
    def on_matched(context, result, sender, device):
        last_event["matched"] = time.monotonic()
        last_event["reports"] = 0
        log.info("Scanner interface matched by IOHIDManager: %s", device_ids(device))

    @ctypes.CFUNCTYPE(None, vp, ctypes.c_int32, vp, vp)
    def on_removed(context, result, sender, device):
        up = time.monotonic() - last_event["matched"] if last_event["matched"] else -1
        log.warning(
            "Scanner interface removed: %s | up %.1fs, %d reports received, %d browser tab(s)",
            device_ids(device),
            up,
            last_event["reports"],
            len(connected_clients),
        )

    @ctypes.CFUNCTYPE(
        None, vp, ctypes.c_int32, vp, ctypes.c_int32, ctypes.c_uint32, ctypes.POINTER(ctypes.c_uint8), ctypes.c_long
    )
    def on_report(context, result, sender, report_type, report_id, report, length):
        try:
            data = [report[i] for i in range(length)]
            last_event["reports"] += 1
            if debug:
                log.info("raw report: %s", " ".join(f"{b:02x}" for b in data))
            decoder.feed(data)
        except Exception:
            log.exception("Error handling HID report")

    manager = iokit.IOHIDManagerCreate(None, 0)
    iokit.IOHIDManagerSetDeviceMatching(manager, match)
    iokit.IOHIDManagerRegisterDeviceMatchingCallback.argtypes = [vp, vp, vp]
    iokit.IOHIDManagerRegisterDeviceRemovalCallback.argtypes = [vp, vp, vp]
    iokit.IOHIDManagerRegisterInputReportCallback.argtypes = [vp, vp, vp]
    iokit.IOHIDManagerRegisterDeviceMatchingCallback(manager, on_matched, None)
    iokit.IOHIDManagerRegisterDeviceRemovalCallback(manager, on_removed, None)
    iokit.IOHIDManagerRegisterInputReportCallback(manager, on_report, None)
    iokit.IOHIDManagerRegisterInputValueCallback(manager, on_value, None)
    mode = ctypes.c_void_p.in_dll(cf, "kCFRunLoopDefaultMode").value
    iokit.IOHIDManagerScheduleWithRunLoop(manager, cf.CFRunLoopGetCurrent(), mode)
    if no_open:
        log.info("--no-open: watching match/remove only, NOT opening the device (no scans will be read)")
        result = 0
    else:
        result = iokit.IOHIDManagerOpen(manager, 1 if exclusive else 0)  # 1 = kIOHIDOptionsTypeSeizeDevice
    if result != 0:
        log.error(
            "IOHIDManagerOpen failed (0x%08x). Add Terminal (or VS Code) under System Settings > "
            "Privacy & Security > Input Monitoring, quit and reopen it, or try sudo.",
            result & 0xFFFFFFFF,
        )
        return
    log.info(
        "Listening to scanner %04x:%04x (%s)",
        vendor_id,
        product_id,
        "exclusive: macOS will not type its scans" if exclusive else "shared",
    )
    cf.CFRunLoopRun()  # blocks; callbacks arrive on this thread


def device_supervisor(vendor_id: int, product_id: int):
    """Keeps one reader thread per scanner HID interface, and reconnects after unplug/replug."""
    active: Dict[bytes, threading.Thread] = {}
    warned = False
    while True:
        for path in list(active):
            if not active[path].is_alive():
                del active[path]
        if active:
            # Do not enumerate while a reader is open: on macOS, hid.enumerate() opens its own
            # connection to the device and disturbs the reader thread (read errors, new device IDs).
            time.sleep(0.5)
            continue
        paths = find_paths(vendor_id, product_id)
        if not paths:
            if not warned:
                log.warning("Scanner %04x:%04x not found. Is it plugged in?", vendor_id, product_id)
                warned = True
        else:
            warned = False
        for path in paths:
            t = threading.Thread(target=read_device, args=(path,), daemon=True)
            t.start()
            active[path] = t
        time.sleep(0.5)


async def handle_client(websocket):
    connected_clients.add(websocket)
    log.info("Browser tab connected (%d total)", len(connected_clients))
    try:
        async for _ in websocket:
            pass  # one-way: the browser only listens
    finally:
        connected_clients.discard(websocket)
        log.info("Browser tab disconnected (%d total)", len(connected_clients))


async def main(vendor_id: int, product_id: int, backend: str = "iokit"):
    global main_loop
    main_loop = asyncio.get_running_loop()
    target = run_iokit_reader if backend == "iokit" else device_supervisor
    threading.Thread(target=target, args=(vendor_id, product_id), daemon=True).start()
    async with websockets.serve(handle_client, WS_HOST, WS_PORT):
        log.info("Scanner bridge listening on ws://%s:%d", WS_HOST, WS_PORT)
        await asyncio.Event().wait()


def list_devices():
    for info in hid.enumerate():
        print(
            f"{info['vendor_id']:04x}:{info['product_id']:04x}  "
            f"usage_page={info.get('usage_page')} usage={info.get('usage')} "
            f"{info.get('manufacturer_string')!r} {info.get('product_string')!r}"
        )


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--debug", action="store_true", help="print raw HID reports")
    parser.add_argument("--list", action="store_true", help="list HID devices and exit")
    parser.add_argument("--vid", type=lambda v: int(v, 16), default=VENDOR_ID, help="vendor id, hex")
    parser.add_argument("--pid", type=lambda v: int(v, 16), default=PRODUCT_ID, help="product id, hex")
    parser.add_argument(
        "--backend",
        choices=["iokit", "hidapi"],
        default="iokit",
        help="iokit (default): shared read, no seize. hidapi: old exclusive-open reader",
    )
    parser.add_argument("--shared", action="store_true", help="do not seize the scanner (macOS may type scans too)")
    parser.add_argument("--no-open", action="store_true", help="diagnostic: do not open the device, only log match/remove")
    args = parser.parse_args()
    debug = args.debug
    no_open = args.no_open
    exclusive = not args.shared
    if args.list:
        list_devices()
    else:
        if args.backend == "hidapi":
            allow_shared_open()
        try:
            asyncio.run(main(args.vid, args.pid, args.backend))
        except KeyboardInterrupt:
            pass
