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
  const figures = svgs.map(
    (svg, i) =>
      `<figure class="lbl" data-n="${i + 1}"><span class="num">${i + 1}</span><span class="tick" aria-hidden="true"></span>${svg}</figure>`,
  );
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
  #msg { position: fixed; left: 50%; bottom: 20px; transform: translateX(-50%); z-index: 5; max-width: 90vw; padding: 10px 16px; border-radius: 8px; background: #3c4043; color: #fff; font-size: 14px; box-shadow: 0 2px 10px rgba(0,0,0,.5); }
  #msg[hidden] { display: none; }
  #msg.err { background: #b3261e; }
  #pickbar .first { display: inline-flex; align-items: center; gap: 6px; }
  #pickbar .first input { width: 70px; }
  main { display: flex; flex-direction: column; align-items: safe center; gap: 20px; padding: 28px 24px 48px; }
  .seg { display: flex; padding: 2px; background: #3c4043; border-radius: 6px; }
  .seg button { height: 30px; padding: 0 12px; border: 0; border-radius: 4px; background: transparent; color: #bdc1c6; font: inherit; font-size: 13px; cursor: pointer; }
  .seg button.on { background: #5f6368; color: #fff; }
  #pickbar { position: sticky; top: 56px; z-index: 1; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 8px 24px; background: #2d3033; border-bottom: 1px solid #3c4043; font-size: 13px; color: #bdc1c6; }
  #pickbar[hidden] { display: none; }
  #pickbar button { height: 28px; padding: 0 10px; border: 1px solid #5f6368; border-radius: 4px; background: transparent; color: #e8eaed; font: inherit; font-size: 13px; cursor: pointer; }
  #pickbar button:hover { background: #3c4043; }
  #pickbar input { height: 28px; width: 150px; padding: 0 8px; border: 1px solid #5f6368; border-radius: 4px; background: #202124; color: #e8eaed; font: inherit; font-size: 13px; }
  #pickcount { margin-left: auto; font-variant-numeric: tabular-nums; }
  .lbl { position: relative; margin: 0; flex: none; }
  .num { position: absolute; top: 4px; right: 6px; z-index: 1; font-size: 11px; color: #5f6368; font-variant-numeric: tabular-nums; pointer-events: none; }
  .tick { display: none; position: absolute; top: 6px; left: -30px; width: 20px; height: 20px; border: 2px solid #9aa0a6; border-radius: 4px; background: #202124; }
  body.custom .tick { display: block; }
  body.custom .lbl { cursor: pointer; user-select: none; }
  body.custom .lbl:not(.sel) svg { opacity: .45; }
  body.custom .lbl.sel svg { outline: 3px solid #34a853; outline-offset: 2px; }
  body.custom .lbl.sel .tick { background: #34a853; border-color: #34a853; }
  body.custom .lbl.sel .tick::after { content: ""; position: absolute; left: 5px; top: 1px; width: 6px; height: 11px; border: solid #fff; border-width: 0 2px 2px 0; transform: rotate(45deg); }
  svg { display: block; flex: none; width: calc(520px * var(--zoom)); height: auto; background: #fff; border-radius: 2px; box-shadow: 0 2px 10px rgba(0,0,0,.55); }
  @media (max-width: 760px) { .meta { display: none; } header { padding: 0 12px; } main { padding: 20px 12px 40px; } #pickbar { padding: 8px 12px; } .tick { left: 4px; top: 4px; } }
  @media print { header, #pickbar, .num, .tick { display: none !important; } body { background: #fff; } main { padding: 0; gap: 0; } .lbl { width: 100%; } svg { width: 100%; box-shadow: none; opacity: 1 !important; outline: 0 !important; } body.custom .lbl:not(.sel) { display: none; } }
</style></head><body>
<header>
  <h1>Labels ${esc(title)}</h1>
  <div class="tools">
    <span class="meta">${count} &middot; ${TSPL_LABEL_W_MM} &times; ${TSPL_LABEL_H_MM} mm</span>
    <div class="seg" role="group" aria-label="Which labels">
      <button id="mode-all" type="button" class="on">All labels</button>
      <button id="mode-custom" type="button">Custom</button>
    </div>
    <div class="zoom" role="group" aria-label="Zoom">
      <button id="zoom-out" type="button" aria-label="Zoom out">&minus;</button>
      <button id="zoom-value" type="button" title="Reset to 50%">50%</button>
      <button id="zoom-in" type="button" aria-label="Zoom in">+</button>
    </div>
    <button id="print" class="print" type="button">Print</button>
  </div>
</header>
<div id="pickbar" hidden>
  <button id="sel-all" type="button">Select all</button>
  <button id="sel-none" type="button">Clear</button>
  <span class="first"><label for="sel-first">First</label><input id="sel-first" type="number" min="1" max="${svgs.length}" inputmode="numeric" placeholder="10" aria-label="Print only the first labels"><button id="sel-first-go" type="button">Select</button></span>
  <input id="sel-range" type="text" placeholder="e.g. 1-5, 8" aria-label="Label numbers to print" autocomplete="off">
  <span>Click labels to choose them. Shift-click selects a range.</span>
  <span id="pickcount"></span>
</div>
<div id="msg" role="status" hidden></div>
<main>${figures.join("")}</main>
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
    if (e.target && e.target.tagName === "INPUT") return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "+" || e.key === "=") step(1);
    else if (e.key === "-") step(-1);
    else if (e.key === "0") { zoom = DEFAULT_ZOOM; apply(); }
  });
  apply();

  // Open PDF: the same labels as a PDF in a new tab. Staff check it there and print with the system print window
  // (nothing is installed on the PC besides the printer's driver).
  var btn = document.getElementById("print");

  // A phone or tablet whose browser can talk to a USB printer prints straight to it (TSPL over WebUSB), since it has no
  // printer driver. Everything else opens the PDF. So only one of the two ever happens.
  var usbMode = (function () {
    var ua = navigator.userAgent || "";
    var mobile = (navigator.userAgentData && navigator.userAgentData.mobile) || /Android|iPhone|iPad|iPod/i.test(ua) ||
      (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
    return !!(mobile && navigator.usb);
  })();
  var verb = usbMode ? "Print" : "Open PDF";
  var msg = document.getElementById("msg");
  var msgTimer = null;
  function say(text, bad) {
    msg.textContent = text;
    msg.className = bad ? "err" : "";
    msg.hidden = false;
    clearTimeout(msgTimer);
    msgTimer = setTimeout(function () { msg.hidden = true; }, 5000);
  }
  async function usbPrint(url) {
    var known = await navigator.usb.getDevices();
    var dev = known.length === 1 ? known[0] : await navigator.usb.requestDevice({ filters: [] });
    var res = await fetch(url, { credentials: "same-origin", cache: "no-store" });
    if (!res.ok) {
      var body = null;
      try { body = await res.json(); } catch (e) {}
      throw new Error((body && body.error) || "Could not get the labels (" + res.status + ").");
    }
    var bytes = new TextEncoder().encode(await res.text());
    if (!dev.opened) await dev.open();
    if (!dev.configuration) await dev.selectConfiguration(1);
    var iface = null, ep = null;
    dev.configuration.interfaces.forEach(function (i) {
      i.alternates.forEach(function (a) {
        a.endpoints.forEach(function (e) {
          if (iface === null && e.direction === "out" && e.type === "bulk") { iface = i.interfaceNumber; ep = e.endpointNumber; }
        });
      });
    });
    if (iface === null) throw new Error("This USB device has no printer endpoint. Pick the label printer.");
    await dev.claimInterface(iface);
    try {
      for (var o = 0; o < bytes.length; o += 4096) {
        var r = await dev.transferOut(ep, bytes.slice(o, o + 4096));
        if (r.status !== "ok") throw new Error("The printer did not accept the data (" + r.status + ").");
      }
    } finally {
      try { await dev.releaseInterface(iface); } catch (e) {}
    }
  }

  // Choosing which labels: "All labels", or "Custom" where you tick the labels you want. Labels are numbered as shown.
  var figs = Array.prototype.slice.call(document.querySelectorAll(".lbl"));
  var total = figs.length;
  var custom = false;
  var selected = {};
  var lastN = null;
  var modeAll = document.getElementById("mode-all");
  var modeCustom = document.getElementById("mode-custom");
  var pickbar = document.getElementById("pickbar");
  var rangeIn = document.getElementById("sel-range");
  var pickCount = document.getElementById("pickcount");
  function picked() {
    var out = [];
    for (var n = 1; n <= total; n++) if (selected[n]) out.push(n);
    return out;
  }
  function compress(nums) {
    var parts = [];
    for (var i = 0; i < nums.length; ) {
      var j = i;
      while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
      parts.push(j > i ? nums[i] + "-" + nums[j] : String(nums[i]));
      i = j + 1;
    }
    return parts.join(",");
  }
  function refresh() {
    var nums = picked();
    figs.forEach(function (f) { f.classList.toggle("sel", !!selected[f.dataset.n]); });
    document.body.classList.toggle("custom", custom);
    modeAll.classList.toggle("on", !custom);
    modeCustom.classList.toggle("on", custom);
    pickbar.hidden = !custom;
    pickCount.textContent = nums.length + " of " + total + " selected";
    if (document.activeElement !== rangeIn) rangeIn.value = compress(nums);
    if (custom) {
      btn.textContent = nums.length ? verb + " " + nums.length + " selected" : "Select labels";
      btn.disabled = nums.length === 0;
    } else {
      btn.textContent = verb + (total > 1 ? " all " + total : "");
      btn.disabled = false;
    }
  }
  modeAll.onclick = function () { custom = false; refresh(); };
  modeCustom.onclick = function () { custom = true; refresh(); };
  document.getElementById("sel-all").onclick = function () {
    for (var n = 1; n <= total; n++) selected[n] = true;
    refresh();
  };
  document.getElementById("sel-none").onclick = function () { selected = {}; lastN = null; refresh(); };
  // "First 10" of a pack of 100: the quickest way to print only some.
  var firstIn = document.getElementById("sel-first");
  function selectFirst() {
    var n = Math.min(Math.floor(Number(firstIn.value)), total);
    if (!(n >= 1)) return;
    selected = {};
    for (var k = 1; k <= n; k++) selected[k] = true;
    lastN = null;
    refresh();
  }
  document.getElementById("sel-first-go").onclick = selectFirst;
  firstIn.addEventListener("keydown", function (e) { if (e.key === "Enter") selectFirst(); });
  figs.forEach(function (f) {
    f.addEventListener("click", function (e) {
      if (!custom) return;
      var n = Number(f.dataset.n);
      var on = !selected[n];
      if (e.shiftKey && lastN !== null) {
        var a = Math.min(lastN, n), b = Math.max(lastN, n);
        for (var k = a; k <= b; k++) selected[k] = on;
      } else {
        selected[n] = on;
      }
      lastN = n;
      refresh();
    });
  });
  rangeIn.addEventListener("input", function () {
    var next = {};
    rangeIn.value.split(",").forEach(function (part) {
      var m = /^\\s*(\\d+)\\s*(?:-\\s*(\\d+)\\s*)?$/.exec(part);
      if (!m) return;
      var a = Number(m[1]), b = m[2] ? Number(m[2]) : a;
      for (var k = Math.max(a, 1); k <= Math.min(b, total); k++) next[k] = true;
    });
    selected = next;
    refresh();
  });
  rangeIn.addEventListener("blur", refresh);
  refresh();
  btn.onclick = function () {
    var nums = picked();
    if (custom && nums.length === 0) return;
    var url = new URL(location.href);
    url.searchParams.set("format", usbMode ? "tspl" : "pdf");
    if (custom) url.searchParams.set("pick", compress(nums));
    else url.searchParams.delete("pick");
    if (!usbMode) { window.open(url.toString(), "_blank"); return; }
    var was = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Printing...";
    usbPrint(url.toString()).then(function () {
      say("Sent " + (custom ? nums.length : total) + " label" + ((custom ? nums.length : total) === 1 ? "" : "s") + " to the printer.");
    }).catch(function (err) {
      var name = err && err.name;
      say(name === "NotFoundError" ? "No printer was chosen." :
        (name === "SecurityError" || name === "NetworkError") ? "Chrome could not open the printer. Unplug and replug it, then try again." :
        (err && err.message) || "Printing failed.", true);
    }).then(function () { btn.textContent = was; refresh(); });
  };
})();
</script>
</body></html>`;
}
