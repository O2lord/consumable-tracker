#!/bin/bash
# Builds dist/consumables-setup.zip: everything a new PC needs for label printing, taken from the repo so nothing
# is copied by hand and goes out of date.
#
#   consumables-setup/
#     README.md                                   the complete guide              (from consumables-setup/)
#     override.crt                                the PUBLIC certificate          (from consumables-setup/)
#     setup-qz-mac.command, setup-qz-windows.*    make QZ Tray trust the app      (from consumables-setup/)
#     extension/                                  the browser extension           (from extension/)
#     print-helper/                               the fallback print helper       (from scripts/print-helper/
#                                                 and scripts/print_bridge.py)
#
# Before the first run, put the PUBLIC certificate in consumables-setup/override.crt:
#   cp ~/qz-keys/certificate.pem consumables-setup/override.crt
# (never the private key: this script and the installers refuse a file that is not a certificate)
# and make sure extension/qz-tray.js exists:
#   curl -L https://cdn.jsdelivr.net/npm/qz-tray@2.2.4/qz-tray.js -o extension/qz-tray.js

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

SRC="consumables-setup"
OUT="dist/consumables-setup.zip"

[ -f "$SRC/override.crt" ] || { echo "Missing $SRC/override.crt. Run: cp ~/qz-keys/certificate.pem $SRC/override.crt"; exit 1; }
head -1 "$SRC/override.crt" | grep -q "BEGIN CERTIFICATE" || { echo "$SRC/override.crt is not a certificate (the first line must be BEGIN CERTIFICATE). It must never be the private key."; exit 1; }
if grep -q "PRIVATE KEY" "$SRC/override.crt"; then echo "$SRC/override.crt contains a private key. Stop and replace it with the certificate only."; exit 1; fi
[ -f extension/qz-tray.js ] || { echo "Missing extension/qz-tray.js. Run: curl -L https://cdn.jsdelivr.net/npm/qz-tray@2.2.4/qz-tray.js -o extension/qz-tray.js"; exit 1; }
[ -f scripts/print_bridge.py ] || { echo "Missing scripts/print_bridge.py"; exit 1; }

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
PKG="$STAGE/consumables-setup"
mkdir -p "$PKG/extension" "$PKG/print-helper"

for f in README.md override.crt setup-qz-mac.command setup-qz-windows.bat setup-qz-windows.ps1; do
  cp "$SRC/$f" "$PKG/$f"
done
cp -R extension/. "$PKG/extension/"
for f in README.md install-mac.command install-windows.bat install-windows.ps1; do
  cp "scripts/print-helper/$f" "$PKG/print-helper/$f"
done
cp scripts/print_bridge.py "$PKG/print-helper/print_bridge.py"

find "$STAGE" -name .DS_Store -delete
chmod +x "$PKG/setup-qz-mac.command" "$PKG/print-helper/install-mac.command"

mkdir -p dist
rm -f "$OUT"
(cd "$STAGE" && zip -qr "$ROOT/$OUT" consumables-setup)

echo "Built $OUT"
unzip -l "$OUT" | tail -n +4 | head -40
