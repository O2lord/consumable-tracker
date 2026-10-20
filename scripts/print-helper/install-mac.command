#!/bin/bash
# Installs the label print helper on this Mac. Double-click it once (or run: bash install-mac.command).
#
# What it does: puts the helper in ~/Library/Application Support/PrintHelper, finds the label printer, and
# registers it so macOS starts it by itself every time this user logs in (and restarts it if it stops).
# Afterwards nobody has to open anything: the app's "Print label to printer" button just works on this Mac.
#
# Before handing the installer out, set DEFAULT_APP_URL below to the address of the deployed app.
# Remove it again with:  bash install-mac.command --uninstall

# ---- set this to the deployed app's address, e.g. https://tracker.uath.example (no trailing slash) ----
DEFAULT_APP_URL="https://uath-consumables.netlify.app/"
# -----------------------------------------------------------------------------------------------------

set -u
cd "$(dirname "$0")" || exit 1

LABEL="com.uath.printhelper"
INSTALL_DIR="$HOME/Library/Application Support/PrintHelper"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"

fail() { echo; echo "Problem: $1"; echo; read -r -p "Press Return to close." _; exit 1; }

stop_helper() {
  launchctl bootout "$DOMAIN" "$PLIST" >/dev/null 2>&1
  launchctl unload "$PLIST" >/dev/null 2>&1
}

if [ "${1:-}" = "--uninstall" ]; then
  stop_helper
  rm -f "$PLIST"
  rm -rf "$INSTALL_DIR"
  echo "The print helper has been removed from this Mac."
  exit 0
fi

APP_URL="${APP_URL:-$DEFAULT_APP_URL}"
if [[ "$APP_URL" == *CHANGE-ME* ]]; then
  read -r -p "Address of the app (for example https://tracker.uath.example): " APP_URL
fi
APP_URL="${APP_URL%/}"
[[ "$APP_URL" =~ ^https?://[^/[:space:]]+$ ]] || fail "The app address must look like https://tracker.uath.example (no path at the end)."

# ---- the helper script, next to this installer or one folder up ----
BRIDGE=""
for candidate in "./print_bridge.py" "../print_bridge.py"; do
  [ -f "$candidate" ] && BRIDGE="$candidate" && break
done
[ -n "$BRIDGE" ] || fail "print_bridge.py was not found next to this installer."

# ---- Python ----
PYTHON="$(command -v python3 || true)"
if [ -z "$PYTHON" ] || ! "$PYTHON" -c "import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)" 2>/dev/null; then
  echo "Python 3 is needed. macOS will offer to install the command line tools: click Install, wait for it to finish, then run this installer again."
  xcode-select --install >/dev/null 2>&1
  fail "Python 3 was not found."
fi

# ---- install ----
stop_helper
mkdir -p "$INSTALL_DIR" "$HOME/Library/LaunchAgents" || fail "Could not create the helper's folder."
cp "$BRIDGE" "$INSTALL_DIR/print_bridge.py" || fail "Could not copy the helper."

if [ ! -x "$INSTALL_DIR/venv/bin/python" ]; then
  echo "Setting up the helper..."
  "$PYTHON" -m venv "$INSTALL_DIR/venv" || fail "Could not create the helper's Python environment."
fi
"$INSTALL_DIR/venv/bin/python" -m pip install --quiet --disable-pip-version-check websockets \
  || fail "Could not install the helper's requirements. Check the internet connection and try again."

# ---- the label printer ----
PRINTER="${PRINTER:-}"
if [ -z "$PRINTER" ]; then
  PRINTERS=()
  while IFS= read -r name; do [ -n "$name" ] && PRINTERS+=("$name"); done < <(lpstat -e 2>/dev/null)
  [ "${#PRINTERS[@]}" -gt 0 ] || fail "No printer is set up on this Mac. Plug in the label printer and add it in System Settings > Printers & Scanners, then run this again."

  GUESS=()
  for name in "${PRINTERS[@]}"; do
    shopt -s nocasematch
    [[ "$name" =~ xprinter|label|365|tsc|zebra ]] && GUESS+=("$name")
    shopt -u nocasematch
  done

  if [ "${#GUESS[@]}" -eq 1 ]; then
    PRINTER="${GUESS[0]}"
  elif [ "${#PRINTERS[@]}" -eq 1 ]; then
    PRINTER="${PRINTERS[0]}"
  else
    echo
    echo "Which one is the label printer?"
    i=1
    for name in "${PRINTERS[@]}"; do echo "  $i) $name"; i=$((i + 1)); done
    while true; do
      read -r -p "Number: " pick
      if [[ "$pick" =~ ^[0-9]+$ ]] && [ "$pick" -ge 1 ] && [ "$pick" -le "${#PRINTERS[@]}" ]; then
        PRINTER="${PRINTERS[$((pick - 1))]}"
        break
      fi
    done
  fi
fi
echo "Label printer: $PRINTER"

# Optional: the browser extension's ID, so issue labels printed from the extension reach the helper too.
EXTENSION_ID="${EXTENSION_ID:-}"
if [ -n "$EXTENSION_ID" ] && ! [[ "$EXTENSION_ID" =~ ^[a-p]{32}$ ]]; then
  fail "EXTENSION_ID should be 32 letters (a to p), copied from the extension's error message."
fi
EXTENSION_ARGS=""
[ -n "$EXTENSION_ID" ] && EXTENSION_ARGS="    <string>--extension-id</string><string>$EXTENSION_ID</string>"

# ---- start at login, restart if it stops ----
cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$INSTALL_DIR/venv/bin/python</string>
    <string>$INSTALL_DIR/print_bridge.py</string>
    <string>--printer</string><string>$PRINTER</string>
    <string>--origin</string><string>$APP_URL</string>
$EXTENSION_ARGS
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>$HOME/print_helper.log</string>
  <key>StandardOutPath</key><string>$HOME/print_helper.log</string>
</dict>
</plist>
PLIST_EOF

launchctl bootstrap "$DOMAIN" "$PLIST" >/dev/null 2>&1 || launchctl load "$PLIST" >/dev/null 2>&1 || fail "macOS would not start the helper. Look in ~/print_helper.log."
sleep 2
launchctl list | grep -q "$LABEL" || fail "The helper did not start. Look in ~/print_helper.log."

echo
echo "Done. The print helper is running and will start by itself whenever this user logs in."
echo "Open the app in Chrome or Edge and use 'Print label to printer'."
echo
read -r -p "Press Return to close." _
