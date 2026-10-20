// Opens the side panel when the toolbar icon is clicked. Everything else lives in the panel and the
// content script; this worker holds no state and no tokens.

function enablePanelOnClick() {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
}

chrome.runtime.onInstalled.addListener(enablePanelOnClick);
chrome.runtime.onStartup.addListener(enablePanelOnClick);
