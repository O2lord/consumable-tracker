# Label print helper: setup guide

The app prints labels to a USB label printer (Xprinter XP-365B) with one click on **Print label to printer**.
A website cannot talk to a USB printer by itself, so a small helper program runs on each PC that has a label
printer plugged in. The browser sends the label commands to the helper, and the helper passes them to the printer.

```
app page in Chrome/Edge  -->  print helper on this PC (localhost:8767)  -->  USB label printer
```

The helper is installed **once per PC** by whoever manages that PC. After that, nobody has to start or open anything:
it starts by itself at login. People just use the print buttons in the app.

What is in this folder:

| File | Purpose |
| --- | --- |
| `install-windows.bat` | Double-click installer for Windows (runs `install-windows.ps1`) |
| `install-windows.ps1` | The Windows installer itself |
| `install-mac.command` | Double-click installer for macOS |
| `../print_bridge.py` | The helper program (the installers copy it) |

---

## 1. Before handing the installers out (once, by the developer)

1. **Set the app's address.** In both installers, replace the placeholder with the address of the deployed app,
   exactly as it appears in the browser address bar (no path at the end):
   - `install-windows.ps1`: `$DefaultAppUrl = "https://tracker.example.org"`
   - `install-mac.command`: `DEFAULT_APP_URL="https://tracker.example.org"`

   If you leave `https://CHANGE-ME`, the installer asks for the address when it runs. The helper only accepts print
   requests from this address, so other websites cannot print on your printer.
2. **Mac only: make the installer executable**, then commit it:
   ```
   chmod +x scripts/print-helper/install-mac.command
   ```
   Otherwise Mac users can run it with `bash install-mac.command`.
3. Give the person installing the whole `scripts/print-helper` folder **and** `scripts/print_bridge.py`.
   They can sit together in one folder, or `print_bridge.py` can stay one folder up as in the repo.

---

## 2. Install on a PC

Plug in the label printer and make sure it is set up in the operating system first (it appears in
Printers & Scanners / Printers).

### Windows

1. Double-click **`install-windows.bat`**.
2. If Python is not installed, the installer installs it (needs internet, takes about a minute).
3. If more than one printer is found, choose the label printer by typing its number.
4. Wait for "Done."

It installs to `%LOCALAPPDATA%\PrintHelper` and adds a shortcut in the Startup folder, so the helper starts when this
user signs in.

**If Windows says "Smart App Control blocked a file that may be unsafe"**, the installer cannot run on this PC. Use
the manual setup in section 2b instead.

### macOS

1. Double-click **`install-mac.command`**. If macOS says it cannot be opened, right-click it, choose **Open**, then
   **Open** again.
2. If macOS offers to install the command line tools, click Install, wait, then run the installer again.
3. If more than one printer is found, choose the label printer by typing its number. The names are the queue names
   shown by `lpstat -p` (for example `Xprinter_XP_365B_2`).
4. Wait for "Done."

It installs to `~/Library/Application Support/PrintHelper` and registers a login item, so macOS starts the helper at
login and restarts it if it stops.

macOS will show a notification such as "Software from Ned Deily can run in the background". This is expected. Ned
Deily is the person who signs the official Python installers for macOS, and the helper runs on that Python. Leave it
allowed in **System Settings > General > Login Items & Extensions**.

---

## 2b. Windows: the installer is blocked (manual setup)

On Windows 11 with **Smart App Control** switched on, double-clicking `install-windows.bat` shows
"Smart App Control blocked a file that may be unsafe". The installer files are unsigned scripts that came from the
internet, and Smart App Control refuses those. Do **not** switch Smart App Control off for this: it can only be turned
back on by resetting Windows. It only blocks scripts that Windows starts by itself, and Python is signed, so the
helper can be started by hand instead. This does exactly what the installer does, one step at a time.
(Right-click the `.bat` > Properties > tick **Unblock** sometimes works, but not reliably.)

**Set up the helper**

1. Install Python 3 from python.org and tick "Add python.exe to PATH" (or run `winget install Python.Python.3.12`).
   Python 3.14 has been tested and works. If `pip` cannot install `pywin32` on a very new Python, use 3.12.
2. Copy `print_bridge.py` to a folder that will stay put, for example `C:\PrintHelper`. Do not leave it in
   Downloads: moving or deleting that folder later breaks the start-at-login shortcut.
3. Open PowerShell in that folder (open it in File Explorer, click the address bar, type `powershell`, Enter) and run:
   ```
   py -m pip install websockets pywin32
   py print_bridge.py --list
   ```
   (If `py` is not recognised, use `python`.) Copy the exact name of the label printer from the list, for example
   `Xprinter XP-365B`.
4. Start the helper, using that printer name and the app's address exactly as it appears in the browser address bar
   (no path, no trailing slash):
   ```
   py print_bridge.py --printer "Xprinter XP-365B" --origin https://uath-consumables.netlify.app
   ```
   The log should say `Print bridge on ws://localhost:8767, printer: ..., allowed origins: ...`. Leave the window open.
5. Test it as in section 3.

**Make it start at login** (do this only after printing works)

1. In PowerShell run `where pythonw` and note the path it prints (it differs between PCs).
2. Press Win+R, type `shell:startup`, Enter. In that folder choose New > Shortcut and paste this as the location,
   with your own `pythonw.exe` path, script folder, printer name and app address:
   ```
   "C:\Users\<you>\AppData\Local\Programs\Python\Python312\pythonw.exe" "C:\PrintHelper\print_bridge.py" --printer "Xprinter XP-365B" --origin https://uath-consumables.netlify.app
   ```
3. Name it `Label Print Helper`, open its Properties and set Run to **Minimized**.
4. Sign out and back in, then check Task Manager > Details for `pythonw.exe`. Once the shortcut runs the helper,
   closing the PowerShell window from step 4 no longer matters.

**Changing anything later** (printer, app address, extension ID): end `pythonw.exe` in Task Manager > Details first,
because the old copy keeps port 8767 busy, then edit the shortcut's target and start it again. The extension ID is
added as `--extension-id <32 letters>` at the end of the command and of the shortcut target (see the browser
extension section below).

---

## 3. Check that it works

1. Open the app in **Chrome or Edge** on that PC (Safari can block the connection to the helper).
2. Open a delivery or batch page and click **Print label to printer**.
3. Print one label first, then two in a row, and check that each comes out on its own label without skipping.

If the helper is not running, the button shows: "The print helper is not running on this computer."

---

## 4. Changing the printer or the app address

Run the installer again. It replaces the old setup. To skip the questions:

- Windows: `install-windows.bat -AppUrl https://tracker.example.org -Printer "Xprinter XP-365B"`
- macOS: `APP_URL=https://tracker.example.org PRINTER=Xprinter_XP_365B_2 bash install-mac.command`

You need to run it again whenever the app moves to a new address.

## 5. Uninstall

- Windows: `install-windows.bat -Uninstall`
- macOS: `bash install-mac.command --uninstall`

---

## Troubleshooting

**"Smart App Control blocked a file that may be unsafe" when running the installer**
- Windows will not run the unsigned `.bat` / `.ps1` installer. Follow the manual setup in section 2b. There is no need
  to turn Smart App Control off.

**Printing worked, but stopped after a restart (manual setup)**
- The start-at-login shortcut is missing or points at a moved folder. Check `shell:startup`, and that the script path
  in the shortcut still exists. Check Task Manager > Details for `pythonw.exe`.
- If you restarted the helper by hand and it says the port is in use, an older copy is still running: end
  `pythonw.exe` in Task Manager first.

**"The print helper is not running on this computer"**
- The installer was not run on this PC, or this is a different PC user. Run it for each user who prints.
- Sign out and back in, or restart. Check the log (below).
- The address in the browser must match the address given to the installer exactly (same `https://`, same host,
  same port). If the app address changed, run the installer again.
- Use Chrome or Edge.

**"The print helper is not running" but the helper is running**
- Look at the end of the log (below). If it shows `line too long` or `did not receive a valid HTTP request`, the
  installed helper is an old copy: the browser's cookies made the connection request too large for it. Run the
  installer again to replace it with the current `print_bridge.py`. Rerunning the installer is also how any update to
  the helper reaches a PC.
- If the log shows nothing when you click, the browser is not reaching the helper at all. Check the address in the
  browser matches the one the helper allows (the log's first lines show it: `allowed origins: ...`).

**Nothing prints, or it prints on the wrong printer**
- Check the printer is on, has labels, and is not showing an error in the system's printer list.
- On a Mac there can be two queues for one printer (for example `Xprinter_XP_365B` and `Xprinter_XP_365B_2`). Only one
  may work. If the first does not print, run the installer again and pick the other one. `lpstat -p` lists them.

**Labels skip, shift or print upside down**
- Layout settings are in `lib/tspl.ts`: label size and gap (`TSPL_LABEL_W_MM`, `TSPL_LABEL_H_MM`, `TSPL_GAP_MM`),
  rotation (`TSPL_DIRECTION`, 0 or 1) and the left margin (`LEFT_X_DOTS`, 8 dots = 1 mm).
- Use the **Preview** link next to the print button to check positions before spending a label.

**Reading the log**
- macOS: `~/print_helper.log`
- Windows: `%USERPROFILE%\print_helper.log`

**Checking that the helper is running**
- macOS: `launchctl list | grep com.uath.printhelper` (a number in the first column means it is running)
- Windows: Task Manager > Details > `pythonw.exe`

---

## The browser extension (issue labels)

**Print issue label** in the extension sends the label to the same helper. The label is laid out for the same
50 x 22 mm roll: hospital number, up to two lines of investigations (with "+N" if more), date and collector, and the
bottle's serial as a barcode. The layout is in `lib/issue-label-tspl.ts`. For a bigger roll, change
`ISSUE_LABEL_W_MM`, `ISSUE_LABEL_H_MM` and `MAX_REFERENCE_LINES` there.

The helper only accepts the app's address by default, so each PC also needs to allow the extension, once:

1. Find the extension's ID (32 letters). Either:
   - open `chrome://extensions` in Chrome, turn on **Developer mode** (top right), and copy the **ID** line under
     "Consumables Tracker", or
   - click **Print issue label** once: if the helper does not allow the extension yet, the error message shows the ID.
2. Run the installer again with that ID:
   - Windows: `install-windows.bat -ExtensionId <the 32 letters>`
   - macOS: `EXTENSION_ID=<the 32 letters> bash install-mac.command`

   Everything can be given in one go, so nothing is asked:
   - Windows: `install-windows.bat -AppUrl https://tracker.example.org -Printer "Xprinter XP-365B" -ExtensionId <the 32 letters>`
   - macOS: `APP_URL=https://tracker.example.org PRINTER=Xprinter_XP_365B_2 EXTENSION_ID=<the 32 letters> bash install-mac.command`

**Windows with the installer blocked (manual setup):** there is no installer to re-run. Add `--extension-id <the 32
letters>` to the end of the helper command (and of the Startup shortcut's target), end `pythonw.exe` in Task Manager if
it is running, and start the helper again. The log's `allowed origins` line should now list
`chrome-extension://<the 32 letters>`. Check the ID against the one shown at `chrome://extensions`: one wrong letter
and printing from the extension is refused.

**Loading the extension on a PC:** the extension is not installed from a store. Keep its `extension` folder somewhere
stable (for example `C:\ConsumablesExtension`), then in Chrome or Edge open `chrome://extensions` (or
`edge://extensions`), turn on Developer mode, choose **Load unpacked** and pick the folder that holds `manifest.json`.
Open the side panel, go to Settings, enter the tracker's address and choose **Save and test**, then allow Chrome's
permission prompt and sign in. The extension only acts on the staff portal pages (`*.betacare.com.ng`).

The ID stays the same as long as the extension is installed from the same source. An extension loaded unpacked from a
folder can get a different ID on each PC, so it is simpler to give every PC the same installed copy.

---

## Notes

- The helper listens on `localhost` only and refuses every origin except the app's address (and
  `http://localhost:3000` for development). It only passes on plain label commands.
- Issue labels printed from the browser extension use the same helper. See the next section.
- Developing on a PC with the printer: the print button also needs the helper there. Either run the installer, or
  start it by hand with `python3 scripts/print_bridge.py --printer <queue name>`.
