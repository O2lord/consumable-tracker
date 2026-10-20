// Runs on the staff portal. For the investigation that is open it reports ONLY these fields:
//
//   Investigation #   MRN   Item   Context   Payment   Status   Destination   Invoice Number
//
// It also keeps, for every investigation the portal has loaded, how far the work has got (started, prepared,
// verified and completed times, and the staff names who did each step) so the panel can keep the tracker
// current and show a bottle's tests. It never reads the patient's name, phone, photo or date of birth, and
// never any result value. It also forwards bottle scans typed
// by a barcode scanner while the portal page has focus, so staff do not have to click into the panel.
//
// The portal is a Flutter web app: it paints onto a canvas, so there is no page text to read. Switching on
// Flutter's accessibility layer to get at text breaks the portal's icon buttons and cannot be switched
// off again, so this script never does that and never reloads the tab. Instead page-hook.js (which runs
// inside the portal page) keeps a short whitelist of fields from the portal's own lab-test responses and hands them
// here; this script looks up the investigation whose id is in the address (/lab-tests/<id>).
//
// If the portal has not loaded the open investigation (for example it was opened by a direct link and the
// portal fetched no lab-test data for it), nothing is guessed: the panel is told it is "not loaded" and
// shows what the extension did see so the reader can be fixed.

(() => {
  "use strict";

  const MRN_RE = /^UATH\/PT\/\d+$/i;
  const IXS_RE = /^IXS\d+$/i;
  const LOAD_WAIT_MS = 6000; // how long after opening an investigation to wait for its data before saying it is missing
  const MAX_ROWS = 500;
  const MAX_SEEN = 15;

  const rows = new Map(); // investigation id -> the whitelisted fields kept by page-hook.js
  let seen = []; // [{ path, rows }] the portal API calls the hook has seen; shapes only
  let hookReady = false;

  const clip = (v) => (v === null || v === undefined ? "" : String(v).slice(0, 200));

  /** The investigation this page shows (the id in /lab-tests/<id>), or null on any other page. */
  function pageKey() {
    const m = location.pathname.match(/\/lab-tests\/([0-9a-f-]{20,})/i);
    return m ? m[1].toLowerCase() : null;
  }

  // --- what page-hook.js has kept ---------------------------------------------------------------------

  let rowsChanged = false;
  let rowsTimer = null;

  function ingest(list) {
    if (!Array.isArray(list)) return;
    for (const r of list) {
      if (!r || typeof r !== "object" || typeof r.id !== "string" || !r.id) continue;
      const id = r.id.toLowerCase();
      // Rebuilt field by field: only the fields listed at the top of this file are ever stored.
      const row = {
        investigationRef: clip(r.investigationRef),
        mrn: clip(r.mrn),
        testName: clip(r.testName),
        payment: clip(r.payment),
        status: clip(r.status),
        destination: clip(r.destination),
        invoice: clip(r.invoice),
        inpatient: r.inpatient === true,
        admissionId: clip(r.admissionId),
        outpatient: r.outpatient === true,
        startedAt: clip(r.startedAt),
        preparedAt: clip(r.preparedAt),
        verifiedAt: clip(r.verifiedAt),
        completedAt: clip(r.completedAt),
        startedBy: clip(r.startedBy),
        preparedBy: clip(r.preparedBy),
        verifiedBy: clip(r.verifiedBy),
        at: typeof r.at === "number" ? r.at : Date.now(),
      };
      // Compared without the capture time, so a refetch that changes nothing does not look like news.
      const { at: _at, ...content } = row;
      row.sig = JSON.stringify(content);
      const before = rows.get(id);
      if (!before || before.sig !== row.sig) rowsChanged = true;
      rows.set(id, row);
    }
    while (rows.size > MAX_ROWS) rows.delete(rows.keys().next().value);
  }

  /** Tell the panel (if it is open) that investigations were added or changed, so it can pick them up. */
  function notifyRows() {
    clearTimeout(rowsTimer);
    rowsTimer = setTimeout(() => {
      try {
        chrome.runtime.sendMessage({ type: "rows-changed" }).catch(() => {});
      } catch {
        /* the extension was reloaded; this page needs a refresh */
      }
    }, 500);
  }

  function noteSeen(path, count) {
    if (typeof path !== "string") return;
    const entry = { path: path.slice(0, 120), rows: typeof count === "number" ? count : null };
    const last = seen[seen.length - 1];
    if (last && last.path === entry.path && last.rows === entry.rows) return;
    seen.push(entry);
    if (seen.length > MAX_SEEN) seen.shift();
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const d = event.data;
    if (!d || d.__ct !== "hook") return;
    hookReady = true;
    if (d.type === "hello") {
      ingest(d.rows);
      if (Array.isArray(d.seen)) {
        seen = [];
        for (const s of d.seen.slice(-MAX_SEEN)) if (s) noteSeen(s.path, s.rows);
      }
    } else if (d.type === "data") {
      ingest(d.rows);
      noteSeen(d.path, d.rowCount);
    } else if (d.type === "seen") {
      noteSeen(d.path, null);
    }
    if (rowsChanged) {
      rowsChanged = false;
      notifyRows();
    }
    schedule();
  });

  /** Ask page-hook.js for everything it has kept so far (it may have run before this script did). */
  function ping() {
    try {
      window.postMessage({ __ct: "content", type: "ping" }, location.origin);
    } catch {
      /* ignore */
    }
  }

  // --- turning a kept row into what the panel expects ---------------------------------------------------

  /** Where the investigation was raised. The portal's fields hold an id for inpatient / outpatient visits. */
  function contextOf(row) {
    if (row.inpatient) return { type: "INPATIENT", label: "Inpatient" };
    if (row.outpatient) return { type: "OUTPATIENT", label: "Outpatient" };
    return { type: "WALK_IN", label: "Walk-in" };
  }

  function mapPayment(text) {
    const t = (text || "").toLowerCase().replace(/[_-]+/g, " ").trim();
    if (t === "paid") return "PAID";
    if (t === "unpaid" || t === "not paid" || t.includes("partial") || t.startsWith("part ")) return "UNPAID";
    return "unknown";
  }

  const pretty = (text) => {
    const t = (text || "").replace(/_/g, " ").trim();
    return t ? t.charAt(0).toUpperCase() + t.slice(1) : "";
  };

  const emptyData = () => ({
    investigationRef: "",
    mrn: "",
    testName: "",
    context: "",
    patientType: null,
    payment: "unknown",
    paymentText: "",
    status: "",
    destination: "",
    invoice: "",
    admissionId: "",
  });

  /** Layout facts only (no page values), shown in the panel when the investigation is not found. */
  function debugInfo() {
    return {
      script: "v9-network",
      frame: window === window.top ? "top" : "sub",
      hookReady,
      investigationsKept: rows.size,
      openInvestigationKept: false,
      portalApiCallsSeen: seen,
    };
  }

  let routeKey = null;
  let routeSince = performance.now();

  /** What the portal has loaded about the open investigation, right now. */
  function snapshot() {
    const key = pageKey();
    if (key !== routeKey) {
      routeKey = key;
      routeSince = performance.now();
    }
    const base = { key, origin: location.origin };
    if (!key) return { ...base, ok: false, notInvestigation: true, problems: [], data: emptyData() };

    const row = rows.get(key);
    if (!row) {
      const waiting = performance.now() - routeSince < LOAD_WAIT_MS;
      return {
        ...base,
        ok: false,
        loading: waiting,
        notLoaded: !waiting,
        problems: [],
        debug: waiting ? undefined : debugInfo(),
        data: emptyData(),
      };
    }

    const problems = [];
    const investigationRef = row.investigationRef.toUpperCase();
    if (!investigationRef) problems.push("The investigation number was not in the data the portal loaded.");
    else if (!IXS_RE.test(investigationRef)) problems.push(`"${investigationRef}" is not a valid investigation number.`);

    const mrn = row.mrn.toUpperCase();
    if (!mrn) problems.push("The patient's hospital number (MRN) was not in the data the portal loaded.");
    else if (!MRN_RE.test(mrn)) problems.push(`"${mrn}" is not a valid hospital number.`);

    if (!row.testName) problems.push("The test name (Item) was not in the data the portal loaded.");

    const ctx = contextOf(row);
    return {
      ...base,
      ok: problems.length === 0,
      problems,
      source: "network",
      capturedAt: row.at,
      debug: problems.length ? { ...debugInfo(), openInvestigationKept: true } : undefined,
      data: {
        investigationRef,
        mrn,
        testName: row.testName,
        context: ctx.label,
        patientType: ctx.type,
        payment: mapPayment(row.payment),
        paymentText: pretty(row.payment),
        status: pretty(row.status),
        destination: row.destination,
        invoice: row.invoice,
        admissionId: row.admissionId,
      },
    };
  }

  // --- tell the panel when the page or its data changes (the portal is a single-page app) ---------------

  let lastSent = "";
  let timer = null;

  function push() {
    const payload = snapshot();
    const key = JSON.stringify(payload);
    if (key === lastSent) return;
    lastSent = key;
    try {
      chrome.runtime.sendMessage({ type: "portal", payload }).catch(() => {});
    } catch {
      /* the extension was reloaded; this page needs a refresh */
    }
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(push, 300);
  }

  // The portal changes address without reloading, so the address is checked once a second. Nothing is
  // sent unless what was read has changed. Until the hook answers, it is asked again each second.
  setInterval(() => {
    if (!hookReady) ping();
    schedule();
  }, 1000);
  ping();
  schedule();

  /** The newest investigations the portal has loaded, in the shape the tracker's sync and the picker use. */
  const ITEMS_SENT = 200;
  function allItems() {
    return Array.from(rows)
      .slice(-ITEMS_SENT)
      .map(([id, r]) => ({
        portalId: id,
        investigationRef: r.investigationRef.toUpperCase(),
        mrn: r.mrn.toUpperCase(),
        testName: r.testName,
        patientType: contextOf(r).type,
        payment: mapPayment(r.payment),
        status: r.status,
        invoice: r.invoice,
        admissionId: r.admissionId,
        destination: r.destination,
        startedAt: r.startedAt,
        preparedAt: r.preparedAt,
        verifiedAt: r.verifiedAt,
        completedAt: r.completedAt,
        startedBy: r.startedBy,
        preparedBy: r.preparedBy,
        verifiedBy: r.verifiedBy,
        capturedAt: r.at,
      }));
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg) return;
    if (msg.type === "read") sendResponse(snapshot());
    else if (msg.type === "rows") sendResponse({ items: allItems() });
    else if (msg.type === "navigate") {
      // Moves this signed-in portal tab to an investigation WITHOUT reloading it: a reload (or a new tab) loses the
      // portal's sign-in. Only the portal's own /lab-tests/<id> address is accepted.
      const ok = typeof msg.path === "string" && /^\/lab-tests\/[0-9a-f-]{20,}$/i.test(msg.path);
      if (!ok) return sendResponse({ ok: false });
      try {
        history.pushState(null, "", msg.path);
        window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
        sendResponse({ ok: true });
      } catch {
        sendResponse({ ok: false });
      }
    }
  });

  // --- forward scanner input ----------------------------------------------------------------------
  // A barcode scanner types like a very fast keyboard and ends with Enter. When nothing editable on the
  // portal has focus, a burst that looks like one of our bottle serials (CT + 9 characters) goes to the panel.

  const SERIAL_LIKE = /^CT[0-9A-Z-]{9,12}$/i;
  let buffer = "";
  let lastKey = 0;

  window.addEventListener(
    "keydown",
    (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target;
      if (target && target.closest && target.closest('input, textarea, select, [contenteditable="true"]')) {
        buffer = "";
        return;
      }
      const now = performance.now();
      if (now - lastKey > 60) buffer = ""; // people type slower than scanners
      lastKey = now;

      if (e.key === "Enter") {
        const code = buffer;
        buffer = "";
        if (SERIAL_LIKE.test(code)) {
          e.preventDefault();
          e.stopPropagation();
          try {
            chrome.runtime.sendMessage({ type: "scan", code }).catch(() => {});
          } catch {
            /* extension reloaded */
          }
        }
        return;
      }
      if (e.key.length === 1) buffer += e.key;
    },
    true,
  );
})();
