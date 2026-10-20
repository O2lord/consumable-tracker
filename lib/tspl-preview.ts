// On-screen preview of the labels that the TSPL printer path prints. It draws the same layout (layoutLabel) the
// printer commands use, so what shows here is where things land on the label. The printer's own built-in fonts
// look a little different from the preview font, so use it to check positions and sizes, not letter shapes.

import { code128Png } from "./barcode.ts";
import type { Label } from "./label-types.ts";
import { FONT_CELL, LABEL_H_DOTS, LABEL_W_DOTS, TSPL_LABEL_H_MM, TSPL_LABEL_W_MM, layoutLabel } from "./tspl.ts";

function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

async function labelSvg(label: Label): Promise<string> {
  const { texts, barcode } = layoutLabel(label);
  const png = await code128Png(barcode.code);
  const href = `data:image/png;base64,${Buffer.from(png).toString("base64")}`;

  const textEls = texts
    .map((t) => {
      const cell = FONT_CELL[t.font];
      return (
        `<text x="${t.x}" y="${t.y + Math.round(cell.h * 0.8)}" font-family="ui-monospace, Menlo, monospace" ` +
        `font-size="${Math.round(cell.h * 0.85)}" textLength="${t.text.length * cell.w}" lengthAdjust="spacingAndGlyphs" ` +
        `fill="#000">${esc(t.text)}</text>`
      );
    })
    .join("");

  // No fixed width or height: the page sizes the label (CSS), and the viewBox keeps its proportions.
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${LABEL_W_DOTS} ${LABEL_H_DOTS}" role="img" aria-label="Label ${esc(barcode.code)}">` +
    `<rect x="0" y="0" width="${LABEL_W_DOTS}" height="${LABEL_H_DOTS}" fill="#fff"/>` +
    `<image x="${barcode.x}" y="${barcode.y}" width="${barcode.width}" height="${barcode.height}" ` +
    `preserveAspectRatio="none" style="image-rendering: pixelated" href="${href}"/>` +
    textEls +
    `</svg>`
  );
}

export async function renderTsplPreviewHtml(labels: Label[], title: string): Promise<string> {
  const svgs = await Promise.all(labels.map(labelSvg));
  const count = `${svgs.length} ${svgs.length === 1 ? "label" : "labels"}`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Labels ${esc(title)}</title>
<style>
  :root { --zoom: .5; }
  * { box-sizing: border-box; }
  html, body { margin: 0; }
  body { min-height: 100vh; background: #282828; color: #e8eaed; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
  header { position: sticky; top: 0; left: 0; z-index: 2; display: flex; align-items: center; justify-content: space-between; gap: 16px;
    padding: 0 24px; height: 56px; background: #323639; box-shadow: 0 1px 4px rgba(0,0,0,.45); }
  header h1 { margin: 0; font-size: 15px; font-weight: 500; letter-spacing: .01em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .meta { font-size: 13px; color: #bdc1c6; white-space: nowrap; }
  .tools { display: flex; align-items: center; gap: 14px; flex: none; }
  .zoom { display: flex; align-items: center; gap: 2px; padding: 2px; background: #3c4043; border-radius: 6px; }
  .zoom button { min-width: 30px; height: 30px; padding: 0 6px; border: 0; border-radius: 4px; background: transparent; color: #e8eaed;
    font: inherit; font-size: 18px; line-height: 1; cursor: pointer; }
  .zoom button#zoom-value { min-width: 56px; font-size: 13px; font-variant-numeric: tabular-nums; }
  .zoom button:hover:not(:disabled) { background: #4a4e51; }
  .zoom button:disabled { opacity: .35; cursor: default; }
  .print { height: 34px; padding: 0 18px; border: 0; border-radius: 6px; background: #2f7d4f; color: #fff; font: inherit; font-size: 14px;
    font-weight: 600; cursor: pointer; }
  .print:hover:not(:disabled) { background: #379158; }
  .print:disabled { opacity: .65; cursor: default; }
  #status { position: fixed; top: 66px; right: 24px; z-index: 3; max-width: min(420px, calc(100vw - 48px)); padding: 10px 14px;
    border-radius: 6px; font-size: 13px; line-height: 1.45; box-shadow: 0 2px 10px rgba(0,0,0,.5); }
  #status[hidden] { display: none; }
  #status.ok { background: #1e4d33; color: #d7f3e1; }
  #status.err { background: #5c2020; color: #fbd5d5; }
  main { display: flex; flex-direction: column; align-items: safe center; gap: 20px; padding: 28px 24px 48px; }
  svg { display: block; flex: none; width: calc(520px * var(--zoom)); height: auto; background: #fff; border-radius: 2px; box-shadow: 0 2px 10px rgba(0,0,0,.55); }
  @media (max-width: 760px) { .meta { display: none; } header { padding: 0 12px; } #status { right: 12px; } main { padding: 20px 12px 40px; } }
  @media print { header, #status { display: none; } body { background: #fff; } main { padding: 0; gap: 0; } svg { width: 100%; box-shadow: none; } }
</style></head><body>
<header>
  <h1>Labels ${esc(title)}</h1>
  <div class="tools">
    <span class="meta">${count} &middot; ${TSPL_LABEL_W_MM} &times; ${TSPL_LABEL_H_MM} mm</span>
    <div class="zoom" role="group" aria-label="Zoom">
      <button id="zoom-out" type="button" aria-label="Zoom out">&minus;</button>
      <button id="zoom-value" type="button" title="Reset to 50%">50%</button>
      <button id="zoom-in" type="button" aria-label="Zoom in">+</button>
    </div>
    <button id="print" class="print" type="button">Print</button>
  </div>
</header>
<div id="status" role="status" hidden></div>
<main>${svgs.join("")}</main>
<script>
(function () {
  var STEPS = [25, 50, 75, 100, 125, 150, 200, 300];
  var DEFAULT_ZOOM = 50;
  var zoom = DEFAULT_ZOOM;
  try {
    var saved = Number(localStorage.getItem("labelPreviewZoom"));
    if (STEPS.indexOf(saved) !== -1) zoom = saved;
  } catch (e) {}
  var out = document.getElementById("zoom-value");
  var minus = document.getElementById("zoom-out");
  var plus = document.getElementById("zoom-in");
  function apply() {
    document.documentElement.style.setProperty("--zoom", String(zoom / 100));
    out.textContent = zoom + "%";
    minus.disabled = zoom <= STEPS[0];
    plus.disabled = zoom >= STEPS[STEPS.length - 1];
    try { localStorage.setItem("labelPreviewZoom", String(zoom)); } catch (e) {}
  }
  function step(dir) {
    var i = STEPS.indexOf(zoom) + dir;
    if (i >= 0 && i < STEPS.length) { zoom = STEPS[i]; apply(); }
  }
  minus.onclick = function () { step(-1); };
  plus.onclick = function () { step(1); };
  out.onclick = function () { zoom = DEFAULT_ZOOM; apply(); };
  document.addEventListener("keydown", function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "+" || e.key === "=") step(1);
    else if (e.key === "-") step(-1);
    else if (e.key === "0") { zoom = DEFAULT_ZOOM; apply(); }
  });
  apply();

  // Print: the same labels as printer commands, passed to the print helper on this computer.
  var HELPER = "ws://localhost:8767";
  var DOWN = "The print helper is not running on this computer. Ask whoever manages this PC to run the print helper installer, or restart the PC if it was installed already.";
  var btn = document.getElementById("print");
  var box = document.getElementById("status");
  var hideTimer = null;
  function show(kind, text) {
    clearTimeout(hideTimer);
    box.className = kind;
    box.textContent = text;
    box.hidden = false;
    if (kind === "ok") hideTimer = setTimeout(function () { box.hidden = true; }, 4000);
  }
  function sendToHelper(tspl) {
    return new Promise(function (resolve, reject) {
      var done = false;
      var socket = null;
      var timer = setTimeout(function () { finish(new Error("The print helper did not answer. Check the printer and try again.")); }, 15000);
      function finish(err, labels) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { if (socket) socket.close(); } catch (e) {}
        if (err) reject(err); else resolve(labels || 0);
      }
      try { socket = new WebSocket(HELPER); } catch (e) { finish(new Error(DOWN)); return; }
      socket.onopen = function () { socket.send(JSON.stringify({ type: "print", tspl: tspl })); };
      socket.onerror = function () { finish(new Error(DOWN)); };
      socket.onclose = function () { finish(new Error(DOWN)); };
      socket.onmessage = function (event) {
        try {
          var reply = JSON.parse(String(event.data));
          if (reply.type === "printed") finish(null, reply.labels);
          else finish(new Error(reply.message || "Printing failed"));
        } catch (e) {
          finish(new Error("The print helper gave an answer that could not be read"));
        }
      };
    });
  }
  btn.onclick = async function () {
    btn.disabled = true;
    btn.textContent = "Printing...";
    box.hidden = true;
    try {
      var url = new URL(location.href);
      url.searchParams.set("format", "tspl");
      var res = await fetch(url.toString(), { cache: "no-store", credentials: "same-origin" });
      if (!res.ok) {
        var body = await res.json().catch(function () { return {}; });
        throw new Error(body.error || "Could not get the labels");
      }
      var sent = await sendToHelper(await res.text());
      show("ok", "Sent " + sent + (sent === 1 ? " label" : " labels") + " to the printer.");
    } catch (err) {
      show("err", err && err.message ? err.message : "Printing failed");
    } finally {
      btn.disabled = false;
      btn.textContent = "Print";
    }
  };
})();
</script>
</body></html>`;
}
