# Scanner setup

How to get the barcode scanner working with the Consumables Tracker extension (side panel) and the tracker web app.

The scanner is a LICON LP1010. It has two USB modes, and which one to use depends on the computer:

| Computer | Mode to use | Why |
| --- | --- | --- |
| **Windows** | **USB keyboard** | Windows types the scanner's codes like a keyboard. Nothing else to set up. |
| **Mac** | **USB CDC** (serial) | macOS drops this scanner's keystrokes in keyboard mode: it beeps but nothing types. In CDC mode the browser reads the scanner directly instead. |

The mode is changed by scanning a setup barcode from the scanner's manual (page "Common Settings", section "Interface Setting"). The setting is stored in the scanner, so it only needs doing once per scanner.

Use **Chrome or Edge**. Safari and Firefox cannot read a scanner in CDC mode.

---

## Windows

1. Plug the scanner into a USB port.
2. Scan the **USB keyboard** barcode from the manual and wait for the beep.
3. Click into a text box (for example Notepad) and scan a label. The code should type itself and press Enter.

That is all. In keyboard mode the extension already picks up scans:

- With the staff portal page focused, a scan that looks like a bottle serial (`CT` followed by 9 to 12 characters) is passed to the side panel.
- In the side panel, the scan box on the Issue, Return and Look up tabs takes the scan as typed text.

**Do not press "Connect scanner" on a Windows PC.** The scanner already types, so reading it a second way would submit each scan twice.

---

## Mac

### 1. Put the scanner in CDC mode

1. Plug the scanner in.
2. Scan the **USB CDC** barcode from the manual and wait for the beep.
3. **Unplug the scanner and plug it back in.** The mode change does not take effect until you do.
4. Check it: Apple menu, hold Option, **System Information**, **USB**. The scanner should be listed as **DECODER-CDC**. (In keyboard mode it is listed as DECODER-KEYBOARD.)

### 2. Connect it in the extension (once)

1. In `chrome://extensions`, make sure the Consumables Tracker extension is loaded and up to date (refresh icon on its card).
2. Make sure no tracker page that has a scan box is holding the scanner. Moving that tab to another page (for example the Dashboard) is enough; you do not need to close it.
3. Open the side panel and click **Connect scanner**.
4. A new tab opens. Click **Choose scanner**, pick **DECODER-CDC** (it appears as `cu.usbmodem...`) and click **Connect**. The list shows only the scanner (it is filtered by the scanner's USB IDs). The tab closes itself.
5. The side panel now shows **USB scanner connected**. Scan a bottle on the Look up tab to test.

Chrome remembers the permission. From then on the side panel reconnects by itself whenever it opens or the scanner is plugged in. You only repeat step 2 on a new computer, a new Chrome profile, or if the extension is removed and installed again.

The picker has to be opened in a normal tab because Chrome cannot show it from inside a side panel.

### 3. Using the tracker web app on a Mac

The tracker pages that scan (Label check, issue, receive and so on) have their own **Connect scanner** button, next to **Use camera**. Click it once, pick **DECODER-CDC** and click Connect. It also remembers the choice.

---

## One reader at a time

Only one page can hold the scanner's serial port. In CDC mode, whichever of these opens it first keeps it:

- the extension's side panel
- a tracker web app page that has a scan box (Label check, issue, receive and so on)

The web app only holds the scanner while a page with a scan box is open. Moving that tab to a page without one (the Dashboard, for example) releases it, so you do not need to close the tab. Closing the side panel releases it too.

If the side panel says **Scanner is in use by a tracker page**, go to a page without a scan box in that tab (or close it) and click **Connect scanner** again. If a tracker page says the scanner is in use by the extension panel, close the panel and click **Connect scanner** on that page. A tab in the background still holds the port while it is on a scan page. A scan goes to whichever page has the scanner, so it is easiest to scan in only one place at a time.

This limit does not apply in keyboard mode on Windows, where the scan is just typed into whatever is focused.

---

## Troubleshooting

**The scanner beeps but nothing happens (Mac).**
It is in keyboard mode. Scan **USB CDC**, unplug and replug, then connect it as above.

**No beep and no red light.**
Try another USB port or adapter, or plug it into another computer to check it works. Scan **Restore factory settings**, wait for the beep, then scan the mode barcode again.

**The picker is empty, or does not list DECODER-CDC.**
The picker only lists the scanner when it is in CDC mode. If the list is empty, the scanner is not in CDC mode yet. Check System Information as in step 1, and make sure you unplugged and replugged after scanning the CDC barcode.

**"Connect scanner" is missing in the side panel.**
The browser does not support Web Serial. Use Chrome or Edge.

**Scans work in the side panel but the tracker page says nothing is connected (or the other way round).**
That is the one-reader limit. Move the page you are not using to one without a scan box, or close it.

**Each scan is submitted twice.**
The scanner is in keyboard mode and also connected through "Connect scanner". Pick one: keyboard mode on Windows, CDC mode on Mac.

**Switching a scanner between a Mac and a Windows PC.**
Scan the mode barcode for the computer you are about to use (CDC for Mac, USB keyboard for Windows). The scanner keeps that mode until you change it.

---

## How it works (for developers)

- In CDC mode the scanner appears as a serial port. `sidepanel.js` opens it with the Web Serial API at 9600 baud, collects the incoming text, and treats a carriage return or line feed as the end of a code. If a code arrives with no terminator, it is treated as complete after 120 ms of silence. Each code is passed to `handleScan()`, the same function the portal page listener uses.
- Chrome stores the serial permission per origin, and the side panel and `scanner.html` share the extension's origin. That is why granting access in `scanner.html` is enough for the side panel.
- No manifest permission is needed for Web Serial.
- The device picker is filtered to the scanner's USB IDs in CDC mode: vendor `0x04D8`, product `0x000A` (Microchip's generic serial device). If a different scanner model is used, change the filter in `scanner.js` and in `components/scanner/ScanInput.tsx`. You can read a paired scanner's IDs in the console with `(await navigator.serial.getPorts())[0].getInfo()`.
- The tracker web app does the same in `components/scanner/ScanInput.tsx`, with its own permission because it is a different origin.
