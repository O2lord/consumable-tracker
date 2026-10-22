# QZ Tray label printing

The app prints labels through **QZ Tray** (https://qz.io), a small program on each PC that has the label printer.
The older **print helper** (`scripts/print_bridge.py`, see `scripts/print-helper/README.md`) stays as the fallback:
the app tries QZ Tray first and uses the helper only when QZ Tray cannot be reached. If QZ Tray is reached but the
print fails, the error is shown and nothing is sent to the helper, so a label never prints twice.

Where this lives in the code:

| What | File |
| --- | --- |
| App pages (Print label buttons) | `lib/print-bridge.ts` |
| Label preview page | `public/print-bridge.js` (same rules, plain JS) |
| Browser extension | `extension/sidepanel.js` + `extension/qz-tray.js` |
| Request signing | `app/api/qz/certificate`, `app/api/qz/sign`, `server/qz/signing.ts` |

Keep the printer name (`Xprinter_XP_365B`) and the QZ library version (`2.2.4`) in step in all three client files.

There are two parts: a one-time setup on the server (section 2, done by whoever manages the app) and a short
checklist for every PC with a label printer (section 1).

**Shortcut for new PCs:** build one zip with everything and send it to each PC.

```bash
cp ~/qz-keys/certificate.pem consumables-setup/override.crt     # the PUBLIC certificate, once
bash scripts/make-setup-zip.sh                                   # -> dist/consumables-setup.zip
```

The zip holds `consumables-setup/` (a plain-language README, the certificate as `override.crt`, and installers that
do step 3 below for you on Mac and Windows) and the browser `extension/`, copied from the repo each time it is
built. It never contains the private key. `*.pem` files are git-ignored on purpose, which is why the certificate
is kept as `override.crt`. Rebuild the zip after changing the extension.

## 1. Setting up a new PC

Do this once per PC. Before you start, section 2 must be done for the server the PC uses.

1. **Install QZ Tray** from https://qz.io/download. In its menu-bar / tray icon menu leave **Automatically start**
   ticked.
2. **Install the label printer** (Xprinter XP-365B) with its normal driver, so a printer named like
   `Xprinter XP-365B` shows up in the PC's printer list. On a Mac that has two queues for it (for example
   `Xprinter_XP_365B` and `Xprinter_XP_365B_2`) make the raw-capable one the default printer (System Settings >
   Printers & Scanners); the app prefers the default printer when several match. Deleting the unused queue avoids
   any mix-up.
3. **Let QZ Tray trust the app's certificate.** You need the certificate file (`certificate.pem` from section 2, or
   save the text that `<app address>/api/qz/certificate` shows while you are signed in). Copy it into QZ Tray's
   folder with the name `override.crt`, then exit QZ Tray from its icon menu and open it again:
   - Mac: `sudo cp certificate.pem "/Applications/QZ Tray.app/Contents/Resources/override.crt"`. macOS may refuse
     ("Operation not permitted") until the app you run the command in (Terminal or VS Code) is allowed under
     System Settings > Privacy & Security > App Management. Restart that app after allowing it.
   - Windows: copy it to `C:\Program Files\QZ Tray\override.crt` (administrator).
4. **Open the app in Chrome or Edge and press a Print button.** QZ Tray shows "Allow?". Tick **Remember this
   decision** and click **Allow**. This is asked once per site on each PC.
5. **If staff use the browser extension:** load it as usual (it needs `extension/qz-tray.js`, see section 3). The
   first print from the extension shows its own "Allow?" popup, because QZ Tray treats the extension as a different
   site. Tick Remember there too.
6. If Chrome cannot connect to QZ Tray, open `https://localhost:8181` once and accept the certificate warning.

Notes:

- QZ Tray updates may replace its application folder. If the popup comes back after an update, check that
  `override.crt` is still there and copy it again if not.
- Instead of copying the file into the application folder you can add `authcert.override=/full/path/to/certificate.pem`
  to `qz-tray.properties` (QZ Tray 2.0.2 and later). That route survives updates, but the properties file is in a
  different place per system; QZ Tray's menu > Advanced > Diagnostic > Browse Shared Folder shows where.
- A certificate bought from QZ (their "Premium Support" / company-branded plans) is already trusted by QZ Tray and
  needs no per-PC file (step 3).

## 2. One-time server setup (signing)

QZ Tray can only remember "Allow" for requests that are signed with a certificate it trusts. The app signs them on
the server with a private key; the browser never sees that key. Without this section the app still prints, but QZ
Tray asks "Allow?" every time a page loads.

Do this once, on your own computer, **outside the repo** (for example in `~/qz-keys`):

```bash
mkdir -p ~/qz-keys && cd ~/qz-keys
openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 3650 \
  -keyout private-key.pem -out certificate.pem -subj "/CN=UATH Consumables Tracker/O=UATH"
```

Then set two environment variables from the files. Each value is the whole file on one line, with the line breaks
written as `\n`. Let a command write the value so nothing is copied by hand:

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

In Netlify (Site configuration > Environment variables) paste the value only: no quotes, no variable name. Redeploy
afterwards. Every server the app or the extension talks to needs both variables (local development and the
deployed site are separate).

Check it: while signed in, open `<app address>/api/qz/certificate`. It should show text starting with
`-----BEGIN CERTIFICATE-----`. If it says "QZ signing is not set up on this server", that server is missing the
variables or has not been restarted or redeployed.

Never commit `private-key.pem`. Keep a backup somewhere safe, and keep a copy of `certificate.pem` to hand for new
PCs (step 3 of section 1). If the key is lost, make a new pair, update the two variables and copy the new
certificate to every PC.

How signing works and what it protects: QZ Tray's browser library sends the SHA-256 hash of each request, not the
request. The server signs only that hash format, and only for a signed-in user who may print labels. It cannot see
which QZ call the hash belongs to, so it cannot limit signing to printing: whoever holds the private key can sign
anything for the PCs that trust the certificate. Keep the key out of git and out of chat messages.

## 3. Browser extension

An extension cannot load scripts from the internet, so QZ's library file must sit in the extension folder. From the
repo root:

```bash
curl -L https://cdn.jsdelivr.net/npm/qz-tray@2.2.4/qz-tray.js -o extension/qz-tray.js
```

Then reload the extension in `chrome://extensions`. Without that file the extension keeps using the print helper.

The extension signs through the server address saved in its Settings, so that server needs the variables from
section 2. `extension/qz-tray.js` is QZ's own file and is excluded from linting.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| "QZ Tray is not available (Unable to establish connection ...)" | QZ Tray is not running, or Chrome does not trust its certificate: open `https://localhost:8181` once. |
| "QZ Tray did not answer" | The Allow popup was not answered within a minute. Press Print again and click Allow. |
| Popup says "An anonymous request" | The server did not return a certificate: `QZ_PRIVATE_KEY` / `QZ_CERTIFICATE` are missing on the server that page or extension talks to, or it was not restarted/redeployed. Check `<address>/api/qz/certificate`. |
| Popup says "Untrusted website" and Allow greys out when Remember is ticked | QZ Tray does not trust the certificate yet: do step 3 of section 1 and restart QZ Tray. |
| "Failed to sign request" | `/api/qz/sign` refused or failed (check the terminal running the server). A 404 means the variables are missing, a 500 means `QZ_PRIVATE_KEY` is not a valid private key. |
| The label prints the commands as text | The wrong queue was used or raw mode is off. The app sends `forceRaw`; make the raw-capable queue the Mac's default printer. |
| "no printer named like Xprinter_XP_365B" | QZ Tray cannot see the printer: check that it is plugged in and its name still contains `Xprinter XP-365B`. |
| Popup keeps asking every time | Signing or trust is not set up (see the two rows above), or the remembered decision was removed in QZ Tray's menu > Advanced > Site Manager. |
