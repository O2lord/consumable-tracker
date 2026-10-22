#!/bin/bash
# Consumables Tracker - label printing setup for a Mac.
# Double-click this file (or run it in Terminal). It makes QZ Tray trust the Consumables Tracker certificate, so QZ
# Tray can remember "Allow" instead of asking every time.

cd "$(dirname "$0")" || exit 1

CERT="override.crt"
APP="/Applications/QZ Tray.app"
DEST="$APP/Contents/Resources/override.crt"

fail() {
  echo
  echo "ERROR: $1"
  echo
  read -r -p "Press Return to close this window..." _
  exit 1
}

[ -f "$CERT" ] || fail "override.crt is missing from this folder. Unzip the whole consumables-setup folder first."
head -1 "$CERT" | grep -q "BEGIN CERTIFICATE" || fail "override.crt is not a certificate. Ask the person who gave you this folder for a new copy."
[ -d "$APP" ] || fail "QZ Tray is not installed. Install it from https://qz.io/download, open it once, then run this setup again."

echo "Consumables Tracker label printing setup"
echo
echo "This copies the certificate into QZ Tray. Your Mac may ask for its password (nothing shows while you type)."
echo

if ! sudo cp "$CERT" "$DEST"; then
  fail "The certificate could not be copied. If it says \"Operation not permitted\": open System Settings > Privacy & Security > App Management, switch on Terminal, quit Terminal completely (Cmd+Q), then double-click this file again."
fi
sudo chmod 644 "$DEST"

if ! cmp -s "$CERT" "$DEST"; then
  fail "The certificate was copied but does not match. Try again."
fi

echo "Certificate installed. Restarting QZ Tray..."
osascript -e 'tell application "QZ Tray" to quit' >/dev/null 2>&1
sleep 3
open -a "QZ Tray"

echo
echo "Done. If the QZ Tray icon is not in the menu bar, open QZ Tray from Applications."
echo "(If it was already open and did not restart: click its menu-bar icon, choose Exit, then open it again.)"
echo
echo "Next: open the Consumables Tracker in Chrome, press a Print button, tick \"Remember this decision\" and click Allow."
echo
read -r -p "Press Return to close this window..." _
