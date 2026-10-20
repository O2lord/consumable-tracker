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

The ID stays the same as long as the extension is installed from the same source. An extension loaded unpacked from a
folder can get a different ID on each PC, so it is simpler to give every PC the same installed copy.

---

## Notes

- The helper listens on `localhost` only and refuses every origin except the app's address (and
  `http://localhost:3000` for development). It only passes on plain label commands.
- Issue labels printed from the browser extension use the same helper. See the next section.
- Developing on a PC with the printer: the print button also needs the helper there. Either run the installer, or
  start it by hand with `python3 scripts/print_bridge.py --printer <queue name>`.
