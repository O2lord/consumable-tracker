// One-time step: Chrome only shows the device picker from a normal tab, not from the side panel. The permission
// is stored for the extension as a whole, so once it is granted here the side panel can open the scanner by itself.
// (A separate file because extension pages cannot run inline scripts.)

const msg = document.getElementById("msg");

function show(kind, text) {
  msg.className = `banner ${kind}`;
  msg.textContent = text;
  msg.hidden = false;
}

document.getElementById("pick").addEventListener("click", async () => {
  if (!navigator.serial) return show("error", "This browser cannot read a USB scanner. Use Chrome or Edge.");
  try {
    // Filtered to the scanner's USB IDs (Microchip 04D8:000A in CDC mode), so the picker lists only the scanner.
    await navigator.serial.requestPort({ filters: [{ usbVendorId: 0x04d8, usbProductId: 0x000a }] }); // only grants access; the side panel opens the port
  } catch (err) {
    if (err && err.name === "NotFoundError") {
      return show("error", "No scanner was chosen, or none was found. Check it is in USB CDC mode and plugged in, then try again.");
    }
    return show("error", `Could not connect: ${err && err.message ? err.message : err}`);
  }
  show("ok", "Scanner allowed. You can close this tab.");
  try {
    await chrome.runtime.sendMessage({ type: "scanner-granted" });
  } catch {
    // The side panel is not open; it connects by itself the next time it opens.
  }
  setTimeout(async () => {
    try {
      const tab = await chrome.tabs.getCurrent();
      if (tab && tab.id !== undefined) chrome.tabs.remove(tab.id);
    } catch {
      // Leave the tab open if it cannot be closed from here.
    }
  }, 1200);
});
