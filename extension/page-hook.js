// Runs INSIDE the staff portal page (manifest "world": "MAIN"), before the portal's own code starts.
//
// The portal is a Flutter web app that paints onto a canvas, so there is no page text to read without
// switching on Flutter's accessibility layer, and that layer breaks the portal's icon buttons. So this
// script never touches the screen. It listens to the portal's own lab-test data instead: when the portal
// loads an investigation (alone or in the lab queue), a copy of the response is read here, and ONLY
// these fields are kept:
//
//   id, investigation_number, patient_mrn, lab_test_name, payment_status, status,
//   destination_name, invoice_number, inpatient_id (the admission; used only to find other tests of the same
//   admission that can share a bottle), whether outpatient_id is filled in, and how far the
//   work has got: when it was started / prepared / verified / completed and the names of the staff who did
//   each step (started_by_name, prepared_by_name, verified_by_name).
//
// The patient's name, phone, date of birth, the clinical summary, the diagnosis, the specimen and anything
// that looks like a result are dropped right here and never leave this file. Nothing is changed in what the portal sends or receives: responses are cloned
// or observed, never altered, and every step is wrapped so a failure here cannot break the portal.
//
// What is kept is handed to content.js (which runs in the extension's own isolated world) with
// window.postMessage. content.js asks for it with a "ping", so it does not matter which script started
// first.

(() => {
  "use strict";
  if (window.__consumablesTrackerHook) return;
  window.__consumablesTrackerHook = true;

  const API_RE = /\/api\//i; // only the portal's API calls are looked at
  const PARSE_RE = /lab-test|investigation/i; // only these responses are read; others are just counted
  const MAX_ROWS = 500;
  const MAX_SEEN = 15;
  const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

  const store = new Map(); // investigation id -> the kept fields
  const seen = []; // [{ path, rows }] shapes of the API calls seen, for diagnosing; no values

  const str = (v) => (v === null || v === undefined ? "" : String(v).trim().slice(0, 200));

  /** The fields kept from an investigation (listed at the top of this file), and nothing else. */
  function pick(o) {
    return {
      id: str(o.id).toLowerCase(),
      investigationRef: str(o.investigation_number),
      mrn: str(o.patient_mrn),
      testName: str(o.lab_test_name),
      payment: str(o.payment_status),
      status: str(o.status),
      destination: str(o.destination_name),
      invoice: str(o.invoice_number),
      inpatient: !!str(o.inpatient_id),
      admissionId: str(o.inpatient_id).toLowerCase(),
      outpatient: !!str(o.outpatient_id),
      startedAt: str(o.started_at),
      preparedAt: str(o.prepared_at),
      verifiedAt: str(o.verified_at),
      completedAt: str(o.completed_at),
      startedBy: str(o.started_by_name),
      preparedBy: str(o.prepared_by_name),
      verifiedBy: str(o.verified_by_name),
      at: Date.now(),
    };
  }

  /** Every object in the response that looks like an investigation (a list, a page of a list, or one). */
  function findRows(node, out, depth) {
    if (!node || typeof node !== "object" || depth > 6 || out.length >= MAX_ROWS) return;
    if (Array.isArray(node)) {
      for (const item of node) findRows(item, out, depth + 1);
      return;
    }
    if (typeof node.id === "string" && typeof node.investigation_number === "string") {
      out.push(pick(node));
      return;
    }
    for (const key of Object.keys(node)) {
      const v = node[key];
      if (v && typeof v === "object") findRows(v, out, depth + 1);
    }
  }

  /** The address without its query, with ids and long numbers replaced, so it can be shown safely. */
  function pathOf(url) {
    try {
      const u = new URL(String(url), location.href);
      return u.pathname.replace(UUID_RE, ":id").replace(/\/\d{3,}/g, "/:n");
    } catch {
      return null;
    }
  }

  function send(message) {
    try {
      window.postMessage({ __ct: "hook", ...message }, location.origin);
    } catch {
      /* nothing to do */
    }
  }

  function note(path, rows) {
    const last = seen[seen.length - 1];
    if (last && last.path === path && last.rows === rows) return;
    seen.push({ path, rows });
    if (seen.length > MAX_SEEN) seen.shift();
  }

  function report(path, json) {
    try {
      const rows = [];
      findRows(json, rows, 0);
      for (const row of rows) {
        if (row.id) store.set(row.id, row);
      }
      while (store.size > MAX_ROWS) store.delete(store.keys().next().value);
      note(path, rows.length);
      send({ type: "data", rows, path, rowCount: rows.length });
    } catch {
      /* ignore */
    }
  }

  function countOnly(path) {
    note(path, null);
    send({ type: "seen", path });
  }

  // --- fetch --------------------------------------------------------------------------------------

  const originalFetch = window.fetch;
  if (typeof originalFetch === "function") {
    window.fetch = function (...args) {
      const promise = originalFetch.apply(this, args);
      try {
        const first = args[0];
        const url = first && typeof first === "object" && "url" in first ? first.url : first;
        const path = pathOf(url);
        if (path && API_RE.test(path)) {
          if (!PARSE_RE.test(path)) {
            countOnly(path);
          } else {
            // Registered before the page gets the promise, so the clone happens before the page reads it.
            promise
              .then((res) => {
                if (!res || !res.ok) return;
                return res
                  .clone()
                  .json()
                  .then((json) => report(path, json));
              })
              .catch(() => {});
          }
        }
      } catch {
        /* never break the portal */
      }
      return promise;
    };
  }

  // --- XMLHttpRequest -----------------------------------------------------------------------------

  const urls = new WeakMap();
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (...args) {
    try {
      urls.set(this, args[1]);
    } catch {
      /* ignore */
    }
    return originalOpen.apply(this, args);
  };

  function readXhr(xhr, path) {
    if (xhr.status < 200 || xhr.status >= 300) return;
    const type = xhr.responseType;
    if (type === "" || type === "text") return report(path, JSON.parse(xhr.responseText));
    if (type === "json") return report(path, xhr.response);
    if (type === "arraybuffer") return report(path, JSON.parse(new TextDecoder().decode(xhr.response)));
    if (type === "blob") {
      return xhr.response
        .text()
        .then((text) => report(path, JSON.parse(text)))
        .catch(() => {});
    }
  }

  XMLHttpRequest.prototype.send = function (...args) {
    try {
      const url = urls.get(this);
      const path = url ? pathOf(url) : null;
      if (path && API_RE.test(path)) {
        if (!PARSE_RE.test(path)) {
          countOnly(path);
        } else {
          this.addEventListener("load", () => {
            try {
              readXhr(this, path);
            } catch {
              /* not JSON, or not readable: ignore */
            }
          });
        }
      }
    } catch {
      /* never break the portal */
    }
    return originalSend.apply(this, args);
  };

  // --- hand what was kept to content.js ---------------------------------------------------------------

  window.addEventListener("message", (event) => {
    if (event.source !== window || !event.data || event.data.__ct !== "content") return;
    if (event.data.type === "ping") {
      send({ type: "hello", rows: Array.from(store.values()), seen: seen.slice() });
    }
  });
})();
