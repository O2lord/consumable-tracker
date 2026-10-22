# Consumables Tracker: label printing setup (complete guide)

This package sets up a PC to print labels from the Consumables Tracker on a USB label printer (Xprinter XP-365B). It
covers setting up a new PC, the browser extension, the fallback print helper, the one-time server setup, updating, and
troubleshooting. Everything you need is in this folder.

## What is in this package

| Item | What it is |
| --- | --- |
| `README.md` | This guide |
| `override.crt` | The app's public certificate. QZ Tray uses it to trust the app. It is not secret. |
| `setup-qz-mac.command` | Mac: installs `override.crt` into QZ Tray and restarts it |
| `setup-qz-windows.bat` / `.ps1` | Windows: the same |
| `extension/` | The browser extension (issue and return bottles, print issue labels) |
| `print-helper/` | The fallback print helper: its own installers, its own detailed guide (`print-helper/README.md`) and the helper program `print_bridge.py` |

## 1. How printing works

A website cannot talk to a USB printer by itself, so a small program on the PC passes the label commands to the printer.
The app supports two such programs and picks automatically:

```
Print button  -->  1. QZ Tray on this PC      -->  USB label printer      (used when it is running)
              -->  2. print helper on this PC -->  USB label printer      (used only when QZ Tray is not reachable)
```

- **QZ Tray** (https://qz.io) is the recommended one: a normal installer, updates itself, nothing to maintain.
- The **print helper** is the older Python program, kept as a fallback.
- If QZ Tray is running but the print fails, the error is shown and nothing is sent to the helper, so a label can never
  print twice.
- The printer is found by name: a printer whose name contains `Xprinter XP-365B` (spaces, dashes and underscores are
  ignored, so `Xprinter_XP_365B_2` matches too). If a PC has several matching queues, the one set as the PC's default
  printer is used.

## 2. Setting up a new PC

Before you start: the server must have the signing keys set up once (section 4). If it does not, printing still works,
but QZ Tray asks "Allow?" every time a page loads.

### Step 1: the printer

Plug in the label printer and install its driver so it shows in the PC's printer list as `Xprinter XP-365B` (Mac:
System Settings > Printers & Scanners; Windows: Settings > Printers & scanners). On a Mac the same printer can appear
twice (`Xprinter XP-365B` and `Xprinter XP-365B 2`). Make the one that prints labels correctly the **default printer**,
and delete the other if you can.

### Step 2: QZ Tray

1. Download and install **QZ Tray** from https://qz.io/download and open it. An icon appears in the Mac menu bar or the
   Windows system tray.
2. Click the icon and make sure **Automatically start** is ticked.

### Step 3: make QZ Tray trust the app

Run the setup file for your system. It copies `override.crt` into QZ Tray and restarts it.

- **Mac:** double-click `setup-qz-mac.command`. If the Mac says it cannot be opened, right-click the file, choose
  **Open**, then **Open** again. Enter the Mac password if asked (nothing shows while you type). If it says "Operation
  not permitted", open System Settings > Privacy & Security > App Management, switch on **Terminal**, quit Terminal
  completely (Cmd+Q) and double-click the file again.
- **Windows:** double-click `setup-qz-windows.bat` and choose **Yes** when Windows asks for permission. Then open QZ Tray
  from the Start menu.

Doing it by hand instead: copy `override.crt` to `/Applications/QZ Tray.app/Contents/Resources/override.crt` (Mac) or
`C:\Program Files\QZ Tray\override.crt` (Windows), then exit QZ Tray from its icon menu and open it again.

### Step 4: the browser extension (only if staff use it)

1. In Chrome or Edge open `chrome://extensions` (or `edge://extensions`) and switch on **Developer mode**.
2. Click **Load unpacked** and choose the `extension` folder from this package. Keep that folder somewhere that stays
   put (for example `C:\ConsumablesExtension`): the extension's ID depends on the folder, and moving it breaks things.
3. Open the extension's side panel, go to Settings, enter the tracker's address, choose **Save and test**, allow
   Chrome's permission prompt and sign in. The extension only acts on the staff portal pages (`*.betacare.com.ng`).

### Step 5: allow it once

1. Open the Consumables Tracker in Chrome or Edge and press **Print label to printer**.
2. QZ Tray asks "Allow?". Tick **Remember this decision**, then click **Allow**. A label prints.
3. If staff use the extension, print once from it as well and do the same. QZ Tray treats the extension as a separate
   site, so it asks again once.

From then on the PC prints without asking. If Chrome cannot connect to QZ Tray at all, open `https://localhost:8181`
once and accept the certificate warning.

### Step 6: check

Print one label, then two in a row, and check that each comes out on its own label and shows a barcode, not lines of
text.

## 3. The fallback print helper

Use it only if QZ Tray cannot be used on a PC (for example it cannot be installed). It is the Python program in
`print-helper/`.

**Install (once per PC and per signed-in user)**
- **Windows:** double-click `print-helper/install-windows.bat`. If more than one printer is found, type the number of
  the label printer.
- **Mac:** double-click `print-helper/install-mac.command` (right-click > Open the first time). The printer names are
  the queue names from `lpstat -p`, for example `Xprinter_XP_365B_2`.

The installer sets it up to start by itself at login. It listens on `localhost:8767` and refuses every website except
the app's address.

**Extension on the helper:** the helper allows only the app's address, so it must also be told the extension's ID once.
Find it at `chrome://extensions` (Developer mode on, the **ID** line under Consumables Tracker), then run the installer
again with it: Windows `install-windows.bat -ExtensionId <the 32 letters>`, Mac
`EXTENSION_ID=<the 32 letters> bash install-mac.command`. This is not needed for QZ Tray.

**Uninstall:** Windows `install-windows.bat -Uninstall`; Mac `bash install-mac.command --uninstall`.

**Check it is running:** Mac `launchctl list | grep com.uath.printhelper` (a number in the first column means it runs);
Windows Task Manager > Details > `pythonw.exe`. The log is `~/print_helper.log` (Mac) or `%USERPROFILE%\print_helper.log`
(Windows).

**If Windows blocks the installer** ("Smart App Control blocked a file that may be unsafe"): do not switch Smart App
Control off. `print-helper/README.md` has the manual setup, step by step, as well as every other helper detail (changing
the printer or app address, label layout, the extension's several-bottle printing).

## 4. One-time server setup (whoever manages the app)

QZ Tray only remembers "Allow" for requests that are signed with a certificate it trusts. The app signs them on the
server with a private key; the browser never sees that key. Do this once, on your own computer, **outside the repo**:

```bash
mkdir -p ~/qz-keys && cd ~/qz-keys
openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 3650 \
  -keyout private-key.pem -out certificate.pem -subj "/CN=UATH Consumables Tracker/O=UATH"
```

Then set two environment variables from the files. Each value is the whole file on one line with the line breaks written
as `\n`. Let a command produce the value so nothing is copied by hand:

```bash
# Local: append both to .env.local (run from ~/qz-keys), then restart `npm run dev`
{
  echo
  printf 'QZ_PRIVATE_KEY='; awk 'NF {sub(/\r/, ""); printf "%s\\n",$0;}' private-key.pem; echo
  printf 'QZ_CERTIFICATE='; awk 'NF {sub(/\r/, ""); printf "%s\\n",$0;}' certificate.pem; echo
} >> /path/to/consumables_barcode_tracker/.env.local

# Netlify: copy one value at a time to the clipboard, then paste it as the variable's value
awk 'NF {sub(/\r/, ""); printf "%s\\n",$0;}' private-key.pem | pbcopy      # -> QZ_PRIVATE_KEY (mark as secret)
awk 'NF {sub(/\r/, ""); printf "%s\\n",$0;}' certificate.pem | pbcopy      # -> QZ_CERTIFICATE
```

In Netlify (Site configuration > Environment variables) paste the value only: no quotes and no variable name, then
redeploy. Every server that the app or the extension talks to needs both variables (local development and the deployed
site are separate).

**Check it:** while signed in, open `<app address>/api/qz/certificate`. It should show text starting with
`-----BEGIN CERTIFICATE-----`. "QZ signing is not set up on this server" means the variables are missing, or the server
was not restarted or redeployed.

**Build this package** (from the repo root):

```bash
cp ~/qz-keys/certificate.pem consumables-setup/override.crt       # the PUBLIC certificate
curl -L https://cdn.jsdelivr.net/npm/qz-tray@2.2.4/qz-tray.js -o extension/qz-tray.js    # once
bash scripts/make-setup-zip.sh                                    # -> dist/consumables-setup.zip
```

The zip is rebuilt from the repo each time, so it always holds the current extension and helper. It never contains the
private key.

**Keep the private key safe.** Never commit `private-key.pem`, never send it in a chat or email, and keep a backup. The
server signs only the hash that QZ Tray's library sends and cannot see which QZ call it belongs to, so whoever holds
the key can sign anything for the PCs that trust the certificate. If the key is lost or leaked, make a new pair, update
the two variables, redeploy and install the new `override.crt` on every PC (rerun the setup file from a rebuilt package).
The certificate made above is valid for 10 years.

## 5. Updating

- **The app:** nothing to do on the PCs.
- **QZ Tray:** it updates itself. An update can replace its folder and remove `override.crt`. If the "Allow" popup
  comes back afterwards, run the setup file from step 3 again.
- **The extension:** keep it loaded from one fixed folder (a git clone of the repo, or this package). To update, replace
  the files (or pull the changes) and click the refresh icon on the extension's card in `chrome://extensions`. The
  extension's ID depends on the folder, so always load it from the same place.
- **The print helper:** run its installer again; that also replaces the helper with the current version.
- **QZ library version (developers):** the app pages, the label preview page and the extension all use `qz-tray` 2.2.4.
  Change all three together (`lib/print-bridge.ts`, `public/print-bridge.js`, `extension/qz-tray.js`), and the printer
  name in the same three places.

## 6. Troubleshooting

| What you see | What to do |
| --- | --- |
| "QZ Tray is not available (Unable to establish connection ...)" | QZ Tray is not running: open it. If it is running, open `https://localhost:8181` once in Chrome and accept the certificate warning. |
| "QZ Tray did not answer" | The Allow popup was not answered within a minute. Press Print again and click Allow. |
| The popup says "An anonymous request" | The server did not return a certificate: `QZ_PRIVATE_KEY` / `QZ_CERTIFICATE` are missing on the server that the page or extension talks to, or it was not restarted or redeployed. Check `<address>/api/qz/certificate`. For the extension, check the address saved in its Settings. |
| The popup says "Untrusted website" and Allow greys out when you tick Remember | QZ Tray does not trust the certificate yet. Run the setup file from step 3, then exit QZ Tray from its icon menu and open it again. If it still says untrusted, the certificate may need to be set with `authcert.override=/full/path/to/override.crt` in QZ Tray's `qz-tray.properties` instead (QZ Tray menu > Advanced > Diagnostic > Browse Shared Folder shows where its files are). |
| "Failed to sign request" | `/api/qz/sign` refused or failed: look at the terminal running the server. A 404 means the variables are missing; a 500 means `QZ_PRIVATE_KEY` is not a valid private key. |
| The popup keeps asking every time | Signing or trust is not set up (the two rows above), or the remembered decision was removed in QZ Tray's menu > Advanced > Site Manager. |
| "no printer named like Xprinter_XP_365B" | QZ Tray cannot see the printer. Check it is plugged in and on, and that its name in the PC's printer list contains `Xprinter XP-365B`. |
| The label prints lines of text (`SIZE 50 mm`, `BARCODE ...`) | The wrong printer queue was used. Make the one that works the PC's default printer and delete the other. |
| "QZ Tray is not available (...) and the print helper failed" | Both ways failed. Fix QZ Tray first (rows above). If you use the helper, see section 3 and `print-helper/README.md`. |
| Labels skip, shift or print upside down | The layout is set in the app (`lib/tspl.ts`): label size and gap, rotation and left margin. Use the **Preview** link beside the print button to check positions before spending a label. |
| "The print helper is not running on this computer" | The helper is not installed or not running for this PC user (section 3), and QZ Tray was not reachable either. |
| Extension prints fail with a message about an extension ID | That is the print helper asking to allow the extension: see "Extension on the helper" in section 3. QZ Tray does not need this. |
| QZ Tray was updated and the popup came back | Run the setup file from step 3 again. |
