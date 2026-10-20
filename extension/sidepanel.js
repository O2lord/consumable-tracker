"use strict";

// Side panel for the staff portal: issue and return sample bottles for the investigation that is open.
// Talks to the tracker's /api/ext/* endpoints with a Bearer token. Page text is only ever shown with
// textContent, never as HTML.

const $ = (id) => document.getElementById(id);
const DEFAULT_BASE = "https://localhost:3000";

// The only tracker hosts this extension will ever talk to (staff passwords, tokens and patient numbers go to
// them). Put the hospital's tracker domain here before installing on the lab systems, for example
// "tracker.hospital.ng". A host listed here also covers its subdomains. localhost is always allowed for development.
const TRACKER_HOSTS = ["uath-consumables.netlify.app"];
const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

const state = {
  baseUrl: DEFAULT_BASE,
  tokens: null, // { accessToken, refreshToken, expiresAt }
  user: null,
  mode: "issue",
  tabId: null,
  portal: null, // { ok, problems, data } from the content script, or null
  testMatches: {}, // test name -> { match } | null while loading
  busy: false,
  forceOverride: false,
  lastIssuedSerial: null,
  unit: null,
  voidReasons: null,
  cache: {}, // investigation key -> { payload, at }: the last good read of each investigation, kept until Chrome closes
  queueItems: [], // every investigation the portal tab has loaded (from the content script), newest last
  synced: {}, // investigation number -> what was last sent to the tracker, so it is sent only when it changes
  syncNote: {}, // investigation number -> a short line about the last update to the tracker
  syncing: false,
  syncAgain: false,
  extra: new Set(), // investigation numbers ticked to share the bottle being issued
  consumables: null, // { key, confirmed, lines: [{ itemTypeId, name, unitOfMeasure, quantity }] } for the open test, editable
  bulkItems: null, // every bulk item that can be added to the list (null until loaded)
  addQuery: "", // what is typed in the add-item search box, kept across redraws
  consumablesIssued: new Set(), // keys (investigation|test) whose items are already issued, so a second bottle does not issue them again
  collected: {}, // investigation number -> bottles already issued for it (null when it could not be checked)
  lookup: null, // the bottle shown on the Look up tab
  portalOrigin: null, // the portal's address (https://host), remembered so Look up can open its pages
};

class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code || null;
  }
}

// --- small helpers --------------------------------------------------------------------------------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function chip(text, kind) {
  return el("span", `chip ${kind || ""}`.trim(), text);
}

function banner(id, kind, text) {
  const b = $(id);
  b.hidden = !text;
  b.className = `banner ${kind || "info"}`;
  b.textContent = text || "";
  // The outcome of an issue or return also pops up over the panel, so it is seen without scrolling.
  if (id === "issue-msg" || id === "return-msg" || id === "lookup-msg") {
    // A look-up only pops up when it fails: its result is the card itself.
    const popup = kind === "error" || (kind === "ok" && id !== "lookup-msg");
    if (text && popup) showResult(kind, text);
    else hideResult();
  }
}

let resultTimer = null;

function showResult(kind, text) {
  clearTimeout(resultTimer);
  const box = $("result-box");
  box.className = `busy-box result-box ${kind}`;
  $("result-icon").textContent = kind === "ok" ? "✓" : "✕";
  $("result-text").textContent = text;
  $("result-overlay").hidden = false;
  // A success clears itself so the next bottle can be scanned straight away; an error stays until it is dismissed.
  if (kind === "ok") resultTimer = setTimeout(hideResult, 4000);
}

function hideResult() {
  clearTimeout(resultTimer);
  const overlay = $("result-overlay");
  if (overlay) overlay.hidden = true;
}

function beep(ok) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = ok ? 880 : 220;
    gain.gain.value = 0.05;
    osc.start();
    osc.stop(ctx.currentTime + (ok ? 0.12 : 0.35));
  } catch {
    /* no audio without a user gesture; the banner is the real feedback */
  }
}

const PATIENT_TYPE_LABEL = { WALK_IN: "Walk-in", OUTPATIENT: "Outpatient", INPATIENT: "Inpatient" };

// --- storage ----------------------------------------------------------------------------------------
// The address is remembered. Tokens live in session storage, so a shared lab PC is signed out when
// Chrome closes.

async function loadState() {
  const local = await chrome.storage.local.get(["baseUrl", "portalOrigin"]);
  state.baseUrl = local.baseUrl || DEFAULT_BASE;
  state.portalOrigin = local.portalOrigin || null;
  const session = await chrome.storage.session.get(["tokens", "user", "cache"]);
  state.tokens = session.tokens || null;
  state.user = session.user || null;
  state.cache = session.cache || {};
}

async function saveCache() {
  await chrome.storage.session.set({ cache: state.cache });
}

async function saveSession() {
  await chrome.storage.session.set({ tokens: state.tokens, user: state.user });
}

async function clearSession() {
  state.tokens = null;
  state.user = null;
  state.cache = {};
  state.synced = {};
  activeRefs = { at: 0, set: new Set() };
  state.syncNote = {};
  state.collected = {};
  state.queueItems = [];
  state.extra.clear();
  state.lookup = null;
  await chrome.storage.session.remove(["tokens", "user", "cache"]);
}

function setTokens(resp) {
  state.tokens = {
    accessToken: resp.accessToken,
    refreshToken: resp.refreshToken || (state.tokens && state.tokens.refreshToken) || null,
    expiresAt: Date.now() + (resp.expiresIn || 3600) * 1000,
  };
  state.user = resp.user;
}

// --- API --------------------------------------------------------------------------------------------

/**
 * Staff passwords and tokens go to this address, so it must be https and its host must be one of TRACKER_HOSTS.
 * Plain http is only for a server on this machine (development).
 */
function isAllowedBase(url) {
  if (LOCAL_HOSTS.includes(url.hostname)) return url.protocol === "https:" || url.protocol === "http:";
  if (url.protocol !== "https:") return false;
  return TRACKER_HOSTS.some((h) => url.hostname === h || url.hostname.endsWith(`.${h}`));
}

async function rawFetch(path, { method = "GET", body, token, base, as = "json" } = {}) {
  const root = (base || state.baseUrl).replace(/\/$/, "");
  let parsed = null;
  try {
    parsed = new URL(root);
  } catch {
    /* handled below */
  }
  // Checked on every request, not only when the address is saved, so an address saved earlier is held to it too.
  if (!parsed || !isAllowedBase(parsed)) {
    throw new ApiError("The tracker address must start with https://. Change it in Settings.", 0);
  }
  const url = root + path;
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  let res;
  try {
    res = await fetch(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, cache: "no-store" });
  } catch {
    throw new ApiError(
      `Cannot reach the tracker at ${base || state.baseUrl}. Check that it is running and that Chrome trusts its certificate.`,
      0,
    );
  }
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new ApiError((data && data.error) || `Request failed (${res.status})`, res.status, data && data.code);
  }
  return as === "blob" ? res.blob() : res.json();
}

let refreshing = null;
function refreshTokens() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const rt = state.tokens && state.tokens.refreshToken;
    if (!rt) throw new ApiError("Your session has expired. Sign in again.", 401);
    const data = await rawFetch("/api/ext/refresh", { method: "POST", body: { refreshToken: rt } });
    setTokens(data);
    await saveSession();
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

async function api(path, opts = {}) {
  if (!state.tokens) throw new ApiError("Sign in first.", 401);
  if (state.tokens.expiresAt - Date.now() < 60_000) {
    try {
      await refreshTokens();
    } catch (err) {
      await expireSession();
      throw err;
    }
  }
  try {
    return await rawFetch(path, { ...opts, token: state.tokens.accessToken });
  } catch (err) {
    if (err instanceof ApiError && err.status === 401 && !opts.retried) {
      try {
        await refreshTokens();
      } catch {
        await expireSession();
        throw new ApiError("Your session has expired. Sign in again.", 401);
      }
      return rawFetch(path, { ...opts, token: state.tokens.accessToken });
    }
    throw err;
  }
}

async function expireSession() {
  await clearSession();
  showLogin("Your session has expired. Sign in again.");
}

// --- views ------------------------------------------------------------------------------------------

function showView(name) {
  for (const v of ["login", "settings", "main"]) $(`view-${v}`).hidden = v !== name;
}

function showLogin(message) {
  showView("login");
  $("login-base").textContent = state.baseUrl;
  banner("login-msg", "error", message || "");
  $("login-password").value = "";
  (($("login-staff").value ? $("login-password") : $("login-staff"))).focus();
}

function enterMain() {
  showView("main");
  const u = state.user;
  $("who").textContent = u ? u.name : "";
  $("where").textContent = u ? [u.locationName || "No home location", u.staffId].join(" · ") : "";
  setMode(state.mode);
  readActiveTab();
  api("/api/ext/me")
    .then(async (user) => {
      state.user = user;
      await saveSession();
      $("who").textContent = user.name;
      $("where").textContent = [user.locationName || "No home location", user.staffId].join(" · ");
      renderGate();
    })
    .catch(() => {});
}

function setMode(mode) {
  state.mode = mode;
  for (const m of ["issue", "return", "lookup"]) {
    $(`tab-${m}`).classList.toggle("active", mode === m);
    $(`pane-${m}`).hidden = mode !== m;
  }
  // The investigation on the page only matters when issuing or returning.
  $("portal-block").hidden = mode === "lookup";
  focusScan();
}

function focusScan() {
  const input = state.mode === "issue" ? $("issue-scan") : state.mode === "return" ? $("return-scan") : $("lookup-scan");
  if (!input.disabled) input.focus();
}

// --- the investigation open on the portal -------------------------------------------------------------

async function readActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  state.tabId = tab ? tab.id : null;
  if (!tab || tab.id === undefined) return setPortal(null);
  try {
    setPortal(await chrome.tabs.sendMessage(tab.id, { type: "read" }));
  } catch {
    setPortal(null); // not a portal lab-test page, or the page needs a refresh after the extension was installed
  }
}

/**
 * The portal tab reports either what the portal has loaded about the open investigation, or that it has
 * not loaded it (yet). If it has not, and this investigation was read before, show the saved copy; it is
 * marked so the panel can say when it was loaded.
 */
function resolvePortal(raw) {
  if (!raw) return null;
  if (raw.notInvestigation) return null;
  const saved = raw.key ? state.cache[raw.key] : null;
  if (saved && (raw.loading || raw.notLoaded)) {
    return { ...saved.payload, key: raw.key, cachedAt: saved.at };
  }
  return raw;
}

function setPortal(raw) {
  const result = resolvePortal(raw);
  const prev = state.portal && state.portal.data ? state.portal.data.investigationRef : null;
  state.portal = result || null;
  const now = state.portal && state.portal.data ? state.portal.data.investigationRef : null;
  if (prev !== now) resetIssueForm();
  renderPortal();
  renderGate();
  if (state.unit) renderUnit();
  const name = state.portal && state.portal.data && state.portal.data.testName;
  if (name && state.user) fetchTestMatch(name);

  // Keep the last good read of each investigation, so the panel still has it if the portal later shows nothing.
  if (raw && raw.ok && raw.key) {
    const saved = state.cache[raw.key];
    if (!saved || saved.at !== raw.capturedAt) {
      state.cache[raw.key] = { payload: raw, at: raw.capturedAt || Date.now() };
      saveCache();
    }
  }

  if (raw && raw.origin) {
    rememberOrigin(raw.origin);
    // The tab this came from is the signed-in portal tab; links open there, since a new tab has to sign in again.
    if (state.tabId !== null) state.portalTabId = state.tabId;
  }
  if (state.lookup) renderLookup();
  if (raw) pullRows();
}

/** Remember the portal's address, so the Look up screen can open an investigation's page in it. */
function rememberOrigin(origin) {
  if (state.portalOrigin === origin) return;
  state.portalOrigin = origin;
  chrome.storage.local.set({ portalOrigin: origin });
}

/**
 * Ask the portal tab for every investigation the portal has loaded (the lab queue, not just the open one).
 * They feed the tracker sync and the "also use this bottle for" list.
 */
async function pullRows() {
  if (state.tabId === null) return;
  try {
    const res = await chrome.tabs.sendMessage(state.tabId, { type: "rows" });
    state.queueItems = (res && res.items) || [];
  } catch {
    state.queueItems = [];
    return;
  }
  renderGate();
  if (state.lookup) renderLookup();
  syncQueue();
}

const SYNC_NOTE = {
  CREATED: "Investigation recorded in the tracker.",
  SAVED: "Tracker updated with the portal's status and progress.",
  UNCHANGED: "Tracker already matches the portal.",
  NOTHING_TO_SAVE: "",
};

/** What the tracker is sent for one investigation: times and staff names only, never result values. */
function syncBody(it) {
  return {
    investigationRef: it.investigationRef,
    mrn: it.mrn,
    testName: it.testName,
    patientType: it.patientType || undefined,
    status: it.status,
    invoice: it.invoice,
    destination: it.destination,
    portalId: it.portalId,
    startedAt: it.startedAt,
    preparedAt: it.preparedAt,
    verifiedAt: it.verifiedAt,
    completedAt: it.completedAt,
    startedBy: it.startedBy,
    preparedBy: it.preparedBy,
    verifiedBy: it.verifiedBy,
  };
}

/**
 * The investigation numbers that have a bottle linked right now, from the tracker (references only). Cached for
 * half a minute. If it cannot be fetched the list is simply empty, so only the open investigation is synced.
 */
let activeRefs = { at: 0, set: new Set() };
async function loadActiveRefs() {
  if (Date.now() - activeRefs.at < 30000) return activeRefs.set;
  try {
    const res = await api("/api/ext/active-refs");
    activeRefs = { at: Date.now(), set: new Set(((res && res.refs) || []).map((r) => String(r).toUpperCase())) };
  } catch {
    activeRefs = { at: Date.now(), set: new Set() };
  }
  return activeRefs.set;
}

/**
 * Brings the tracker up to date, for ONLY the investigation open on the portal and the ones that have a bottle
 * linked right now. The rest of what the portal loaded (the lab queue) stays in the browser and is never sent.
 * Records the open one if the tracker has not seen it and updates status, invoice and progress on the rest.
 * Only what changed since last time is sent, in batches of up to 50. A failure never blocks issuing or
 * returning: it only shows a short note.
 */
async function syncQueue() {
  if (!state.user) return;
  if (state.syncing) {
    state.syncAgain = true;
    return;
  }
  state.syncing = true;
  try {
    do {
      state.syncAgain = false;
      const linked = await loadActiveRefs();
      const openRef = String((state.portal && state.portal.data && state.portal.data.investigationRef) || "").toUpperCase();
      const pending = state.queueItems
        .filter((it) => it.investigationRef && it.mrn)
        .filter((it) => {
          const ref = it.investigationRef.toUpperCase();
          return ref === openRef || linked.has(ref);
        })
        .map((it) => ({ it, sig: JSON.stringify(syncBody(it)) }))
        .filter(({ it, sig }) => state.synced[it.investigationRef] !== sig);
      for (let i = 0; i < pending.length; i += 50) {
        const chunk = pending.slice(i, i + 50);
        for (const { it, sig } of chunk) state.synced[it.investigationRef] = sig;
        try {
          const res = await api("/api/ext/sync", { method: "POST", body: { items: chunk.map(({ it }) => syncBody(it)) } });
          for (const r of res.results || []) {
            state.syncNote[r.investigationRef] =
              r.outcome === "REFUSED" ? `Could not update the tracker: ${r.message}` : SYNC_NOTE[r.outcome] || "";
          }
        } catch (err) {
          // A refusal will not change by asking again; a network or server problem might, so ask again later.
          if (!(err instanceof ApiError) || err.status === 0 || err.status >= 500 || err.status === 401) {
            for (const { it } of chunk) delete state.synced[it.investigationRef];
            break;
          }
          for (const { it } of chunk) state.syncNote[it.investigationRef] = `Could not update the tracker: ${err.message}`;
        }
      }
    } while (state.syncAgain);
  } finally {
    state.syncing = false;
  }
  renderPortal();
}

function resetIssueForm() {
  state.extra.clear();
  state.forceOverride = false;
  state.lastIssuedSerial = null;
  $("collector-type").value = "PATIENT";
  if ($("collector-type")._refresh) $("collector-type")._refresh();
  $("collector-name").value = "";
  $("collector-name-wrap").hidden = true;
  $("override-reason").value = "";
  $("print-btn").hidden = true;
  banner("issue-msg", "", "");
}

/** Bottles already issued for an investigation, so the panel can say a sample was already collected. */
async function fetchCollected(ref, force = false) {
  if (!ref || !state.user) return;
  if (!force && Object.prototype.hasOwnProperty.call(state.collected, ref)) return;
  state.collected[ref] = undefined; // asked; the answer is on its way
  try {
    const res = await api(`/api/ext/investigation-bottles?ref=${encodeURIComponent(ref)}`);
    state.collected[ref] = res.bottles || [];
  } catch {
    state.collected[ref] = null; // could not be checked; nothing is shown
  }
  renderPortal();
}

function collectedRow(dl, ref) {
  if (!Object.prototype.hasOwnProperty.call(state.collected, ref)) return;
  const list = state.collected[ref];
  if (list === null) return;
  if (list === undefined) return kv(dl, "Sample bottle", "Checking…");
  if (list.length === 0) return kv(dl, "Sample bottle", chip("Not collected yet", ""));
  const box = el("div");
  // Only a bottle still out there means the sample is collected. One returned as used, unused or unusable leaves
  // the investigation free for another bottle.
  const stillOut = list.some((b) => b.state === "ISSUED");
  box.append(stillOut ? chip("Already collected", "info") : chip("Returned, another bottle can be issued", "alt"));
  for (const b of list) {
    // The bottle's own state decides, not the link: a bottle returned as used is RETURNED but its link stays open.
    // The word stays "Returned"; the colour says how it came back. For the full history the attendant copies the code and looks it up.
    const [status, kind, hint] =
      b.state === "ISSUED"
        ? ["Still out there", "warn", "Issued and not returned yet"]
        : b.state === "RETURNED"
          ? ["Returned", "ok", "Returned used, sample inside"]
          : b.state === "IN_STOCK"
            ? ["Returned", "alt", "Returned unused and intact"]
            : b.state === "VOIDED"
              ? ["Returned", "bad", "Returned unusable"]
              : ["Already collected", "info", ""];
    const row = el("div", "bottle-row");
    const tag = chip(status, kind);
    if (hint) tag.title = hint;
    row.append(el("strong", "small", b.serial), tag);
    box.append(row);
  }
  kv(dl, "Sample bottle", box);
}

async function fetchTestMatch(name) {
  if (Object.prototype.hasOwnProperty.call(state.testMatches, name)) return;
  state.testMatches[name] = undefined;
  try {
    state.testMatches[name] = await api(`/api/ext/test-match?name=${encodeURIComponent(name)}`);
  } catch {
    delete state.testMatches[name];
    return;
  }
  renderPortal();
  renderGate();
}

/**
 * Cross-checks what was read. "Raised as" is how the investigation is billed: Walk-in and Outpatient
 * investigations get an invoice that must be paid, Inpatient ones are charged to the admission and show
 * no invoice. A mismatch usually means a field was read wrongly (or the portal changed), so it is shown
 * as a warning for the attendant. It never blocks an issue by itself.
 */
function sanityWarnings(d) {
  const warnings = [];
  const hasInvoice = !!(d.invoice && d.invoice.trim() && d.invoice.trim() !== "-");
  const label = PATIENT_TYPE_LABEL[d.patientType] || "";
  if (d.patientType === "INPATIENT" && hasInvoice) {
    warnings.push(
      `Raised as Inpatient, but it has an invoice (${d.invoice}). Inpatient investigations are normally charged to the admission with no invoice. Check Context and Invoice on the portal.`,
    );
  }
  if ((d.patientType === "WALK_IN" || d.patientType === "OUTPATIENT") && !hasInvoice) {
    warnings.push(
      `Raised as ${label}, but no invoice number was read. Payment normally goes through an invoice, so check the portal before issuing.`,
    );
  }
  if (d.payment === "PAID" && d.patientType !== "INPATIENT" && !hasInvoice) {
    warnings.push("Shows Paid, but there is no invoice to pay against. Check the portal.");
  }
  return warnings;
}

function kv(dl, label, value) {
  dl.append(el("dt", "", label));
  const dd = el("dd");
  if (value instanceof Node) dd.append(value);
  else dd.textContent = value;
  dl.append(dd);
}

function appendDebug(card, debug) {
  const details = el("details");
  details.append(el("summary", "small muted", "Reader details (send a screenshot of this)"));
  const pre = el("pre", "small", JSON.stringify(debug, null, 1));
  pre.style.whiteSpace = "pre-wrap";
  details.append(pre);
  details.open = true;
  card.append(details);
}

function renderPortal() {
  const card = $("portal");
  card.replaceChildren();
  const p = state.portal;
  if (!p) {
    card.append(el("div", "empty", "Open an investigation in the staff portal (Lab Tests) to begin. If it is already open, reload that tab once."));
    return;
  }
  const d = p.data;
  if (p.loading) {
    card.append(el("div", "empty", "Waiting for the portal to load this investigation…"));
    return;
  }
  if (p.notLoaded) {
    card.append(
      el(
        "div",
        "empty",
        "The portal has not loaded this investigation's details. Open it from the Lab Tests list, or press Refresh on the portal page, then press Read page here.",
      ),
    );
    if (p.debug) appendDebug(card, p.debug);
    return;
  }
  const dl = el("dl", "kv");
  kv(dl, "Investigation", d.investigationRef || "-");
  kv(dl, "Test", d.testName || "-");
  kv(dl, "Patient no.", d.mrn || "-");
  kv(dl, "Raised as", chip(PATIENT_TYPE_LABEL[d.patientType] || d.context || "Not shown", d.patientType ? "" : "bad"));
  const payKind = d.payment === "PAID" ? "ok" : d.payment === "UNPAID" ? (d.patientType === "INPATIENT" ? "" : "bad") : "warn";
  kv(dl, "Payment", chip(d.paymentText || "Not shown", payKind));
  kv(dl, "Status", d.status || "-");
  kv(dl, "Invoice", d.invoice || "-");

  if (d.testName) {
    const tm = state.testMatches[d.testName];
    if (tm === undefined) kv(dl, "Bottle needed", "Checking…");
    else if (tm.match) kv(dl, "Bottle needed", `${bottleNeeded(tm.match)} (${tm.match.code})`);
    else kv(dl, "Bottle needed", chip("Not in test catalog", "bad"));
  }
  if (p.ok && d.investigationRef) {
    fetchCollected(d.investigationRef);
    collectedRow(dl, d.investigationRef);
  }
  card.append(dl);

  const warnings = p.ok ? sanityWarnings(d) : [];
  if (warnings.length) {
    const ul = el("ul", "gate");
    for (const w of warnings) ul.append(el("li", "", w));
    card.append(ul);
  }

  if (!p.ok) {
    const ul = el("ul", "gate");
    for (const problem of p.problems) ul.append(el("li", "", problem));
    card.append(ul);
    if (p.debug) appendDebug(card, p.debug);
  }
  if (p.cachedAt) {
    const time = new Date(p.cachedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    card.append(
      el(
        "p",
        "muted small",
        `The portal is not showing this investigation right now, so this is the copy it last loaded at ${time}. If something changed (for example payment), press Refresh on the portal page, then Read page.`,
      ),
    );
  } else if (p.capturedAt) {
    const time = new Date(p.capturedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    card.append(
      el(
        "p",
        "muted small",
        `Details as the portal last loaded them at ${time}. If payment or status changed since, press Refresh on the portal page.`,
      ),
    );
  }
  const note = d && d.investigationRef ? state.syncNote[d.investigationRef] : "";
  if (note) card.append(el("p", "muted small", note));
}

/** Check the portal tab again. Nothing is switched on in the portal and the tab is never reloaded. */
async function readPage() {
  state.testMatches = {};
  state.consumables = null; // pick up any change to the test's standard items
  state.collected = {};
  state.voidReasons = null;
  await readActiveTab();
}

// --- issue ------------------------------------------------------------------------------------------

function issueGate() {
  const p = state.portal;
  const u = state.user;
  const reasons = [];
  const needsOverride = false;
  if (!p) return { blocked: true, silent: true, reasons, needsOverride };
  if (!p.ok) return { blocked: true, silent: true, reasons, needsOverride }; // the portal card lists the problems
  const d = p.data;
  if (/cancel/i.test(d.status || "")) reasons.push("This investigation is cancelled.");
  // Payment is shown on the card for information only. The EMR decides whether a test goes ahead, so the
  // panel does not hold back an issue because of the payment badge.
  const tm = state.testMatches[d.testName];
  if (tm && tm.match === null) reasons.push(`"${d.testName}" is not in the test catalog. Ask an admin to add it.`);
  if (u && u.can && !u.can.issue) reasons.push("Your account is not allowed to issue bottles.");
  // A bench section or the blood bank uses stock for its department, not per patient.
  if (u && u.departmentOnly) {
    reasons.push(
      `${u.locationName || "Your location"} uses stock for its department, not per patient, so a bottle cannot be issued to an investigation from here. Use Issue on the tracker instead.`,
    );
  }
  return { blocked: reasons.length > 0, silent: false, reasons, needsOverride };
}

function renderGate() {
  const gate = issueGate();
  const ul = $("gate");
  ul.replaceChildren();
  for (const r of gate.reasons) ul.append(el("li", "", r));
  ul.hidden = gate.reasons.length === 0;

  const showOverride = gate.needsOverride || state.forceOverride;
  $("override-wrap").hidden = !showOverride;
  $("override-label").textContent = gate.needsOverride
    ? "Not paid: supervisor override reason"
    : "Supervisor override reason (then scan the bottle again)";

  $("issue-scan").disabled = gate.blocked;
  $("issue-scan").placeholder = gate.blocked
    ? "Waiting for a valid investigation…"
    : "Scan or type the serial, then Enter";
  renderConsumables();
  renderSiblings();
}

/**
 * The bulk items (swabs, cotton wool...) the open investigation's test normally uses. They start as the test's
 * standard list and can be corrected or removed here; whatever is left is issued together with the bottle.
 * Rebuilt only when the investigation or its test changes, so edits survive a redraw.
 */
function currentConsumables() {
  const p = state.portal;
  if (!p || !p.ok) return null;
  const d = p.data;
  const tm = state.testMatches[d.testName];
  if (!tm || !tm.match) return null;
  const key = `${d.investigationRef}|${tm.match.code}`;
  if (!state.consumables || state.consumables.key !== key) {
    state.consumables = {
      key,
      confirmed: Boolean(tm.match.standardItemsConfirmed),
      lines: (tm.match.standardItems || []).map((i) => ({ ...i })),
    };
  }
  return state.consumables;
}

function renderConsumables() {
  const box = $("consumables");
  box.replaceChildren();
  const c = issueGate().blocked ? null : currentConsumables();
  if (!c) {
    box.hidden = true;
    return;
  }
  fetchBulkItems();
  const done = state.consumablesIssued.has(c.key);
  box.hidden = false;
  box.append(el("p", "small", "Items used for this test (issued with the bottle)"));
  if (done) {
    box.append(el("p", "muted small", "These items are already issued for this test. Scanning another bottle will not issue them again."));
    return;
  }
  if (!c.confirmed) {
    box.append(el("p", "muted small", "The lab has not confirmed this list yet. Correct any quantity that is wrong."));
  }
  for (const line of c.lines) {
    const row = el("div", "consumable");
    const qty = document.createElement("input");
    qty.type = "number";
    qty.min = "1";
    qty.step = "1";
    qty.value = String(line.quantity);
    qty.addEventListener("input", () => {
      line.quantity = Number(qty.value);
    });
    const remove = el("button", "link", "Remove");
    remove.type = "button";
    remove.addEventListener("click", () => {
      c.lines = c.lines.filter((l) => l !== line);
      renderConsumables();
    });
    row.append(el("span", "", `${line.name} (${line.unitOfMeasure})`), qty, remove);
    box.append(row);
  }
  if (c.lines.length === 0) box.append(el("p", "muted small", "No items will be issued with this bottle."));

  // Add an item the test does not list (or one that was removed). Items already in the list are not offered.
  const addable = (state.bulkItems || []).filter((i) => !c.lines.some((l) => l.itemTypeId === i.itemTypeId));
  if (addable.length) {
    box.append(
      itemPicker(addable, (item) => {
        c.lines.push({ ...item, quantity: 1 });
        state.addQuery = "";
        renderConsumables();
      }),
    );
  } else if (state.bulkItems === null) {
    box.append(el("p", "muted small", "Loading the item list…"));
  }
}

/**
 * A search box with the matching items listed under it. Typing narrows the list; clicking an item, or the arrow
 * keys and Enter, adds it. Our own control instead of a native <select>, which cannot be searched.
 */
function itemPicker(items, onPick) {
  const wrap = el("div", "picker");
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "Search items to add…";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.value = state.addQuery || "";
  const list = el("ul", "picker-list");
  list.hidden = true;
  let matches = [];
  let active = 0;

  function fill() {
    state.addQuery = input.value;
    const q = input.value.trim().toLowerCase();
    matches = q ? items.filter((i) => i.name.toLowerCase().includes(q)) : items;
    if (active >= matches.length) active = Math.max(0, matches.length - 1);
    list.replaceChildren();
    if (matches.length === 0) {
      list.append(el("li", "picker-empty", "No item matches"));
      return;
    }
    matches.forEach((item, idx) => {
      const li = el("li", idx === active ? "picker-item on" : "picker-item", `${item.name} (${item.unitOfMeasure})`);
      // mousedown (not click) so the pick happens before the box loses focus and hides the list
      li.addEventListener("mousedown", (e) => {
        e.preventDefault();
        onPick(item);
      });
      list.append(li);
    });
    const on = list.querySelector(".on");
    if (on) on.scrollIntoView({ block: "nearest" });
  }

  input.addEventListener("focus", () => {
    list.hidden = false;
    fill();
  });
  input.addEventListener("blur", () => {
    list.hidden = true;
  });
  input.addEventListener("input", () => {
    active = 0;
    list.hidden = false;
    fill();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      active = Math.min(active + 1, matches.length - 1);
      fill();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      active = Math.max(active - 1, 0);
      fill();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (matches[active]) onPick(matches[active]);
    } else if (e.key === "Escape") {
      list.hidden = true;
      input.blur();
    }
  });
  wrap.append(input, list);
  return wrap;
}

async function fetchBulkItems() {
  if (state.bulkItems !== null || state.bulkItemsLoading) return;
  state.bulkItemsLoading = true;
  try {
    state.bulkItems = (await api("/api/ext/bulk-items")).items || [];
    renderConsumables();
  } catch {
    // Leave it unloaded; the next redraw tries again.
  } finally {
    state.bulkItemsLoading = false;
  }
}

/**
 * Other pending tests of the same patient that were raised together: the same invoice, or for an inpatient the
 * same admission (inpatient tests are charged to the admission and often have no invoice). Which of them can
 * actually share this bottle is decided in renderSiblings.
 */
function siblingItems() {
  const p = state.portal;
  if (!p || !p.ok) return [];
  const d = p.data;
  const invoice = (d.invoice || "").trim();
  const byAdmission = d.patientType === "INPATIENT";
  if (byAdmission ? !d.admissionId : !invoice || invoice === "-") return [];
  return state.queueItems
    .filter(
      (it) =>
        it.mrn === d.mrn &&
        (byAdmission ? it.admissionId === d.admissionId : (it.invoice || "").trim() === invoice) &&
        it.investigationRef !== d.investigationRef &&
        /^pending$/i.test(it.status || ""),
    )
    .sort((a, b) => a.investigationRef.localeCompare(b.investigationRef));
}

/** Containers a catalog match accepts, required one first; empty means any container. */
function acceptedOf(match) {
  if (Array.isArray(match.acceptedContainers)) return match.acceptedContainers;
  return match.requiredContainer ? [match.requiredContainer] : [];
}

/** The same rule as lib/containers.ts canShareBottle: both accept anything, or they have a container in common. */
function canShareBottle(a, b) {
  if (a.length === 0 || b.length === 0) return a.length === b.length;
  return a.some((c) => b.includes(c));
}

/** "EDTA", "PLAIN or GEL", or "Any container". */
function bottleNeeded(match) {
  const accepted = acceptedOf(match);
  return accepted.length ? accepted.join(" or ") : "Any container";
}

function renderSiblings() {
  const box = $("siblings");
  box.replaceChildren();
  const candidates = issueGate().blocked ? [] : siblingItems();
  const d = state.portal && state.portal.data;
  const own = d ? state.testMatches[d.testName] : undefined;
  const need = own && own.match ? acceptedOf(own.match) : null; // null while it is still being checked
  for (const it of candidates) if (state.user) fetchTestMatch(it.testName);
  // Only tests this same bottle can serve are listed: the ones that accept at least one container in common
  // with this test (a plain-or-gel test can share with a plain-only one). One that needs a different
  // container, is not in the catalog, or is still being checked is left out (it appears once its container is
  // known). The server checks the whole group again when the bottle is scanned.
  const list =
    need === null
      ? []
      : candidates.filter((it) => {
          const m = state.testMatches[it.testName];
          return Boolean(m && m.match && canShareBottle(need, acceptedOf(m.match)));
        });
  // A test that is not in the catalog is a data gap an admin has to fix, so it is called out instead of left out.
  const missing = candidates.filter((it) => {
    const m = state.testMatches[it.testName];
    return Boolean(m) && m.match === null;
  });
  for (const ref of [...state.extra]) if (!list.some((s) => s.investigationRef === ref)) state.extra.delete(ref);
  box.hidden = list.length === 0 && missing.length === 0;
  if (box.hidden) return;

  if (list.length) {
    box.append(el("p", "muted small", "Also use this bottle for these tests (same patient, same invoice or admission, same bottle type):"));
  }
  for (const it of list) {
    const row = el("label", "sibling");
    const box1 = document.createElement("input");
    box1.type = "checkbox";
    box1.checked = state.extra.has(it.investigationRef);
    box1.addEventListener("change", () => {
      if (box1.checked) state.extra.add(it.investigationRef);
      else state.extra.delete(it.investigationRef);
    });
    const text = el("span", "", `${it.investigationRef} · ${it.testName}${it.payment === "UNPAID" ? " (not paid)" : ""}`);
    row.append(box1, text);
    box.append(row);
  }
  if (missing.length) {
    const names = missing.map((it) => `${it.investigationRef} (${it.testName})`).join(", ");
    box.append(
      el(
        "p",
        "muted small",
        `${names} ${missing.length === 1 ? "is" : "are"} not in the test catalog, so ${missing.length === 1 ? "it" : "they"} cannot be added. Ask an admin to add ${missing.length === 1 ? "it" : "them"}.`,
      ),
    );
  }
}

async function doIssue(serial) {
  if (state.busy) return;
  const gate = issueGate();
  if (gate.blocked) {
    if (gate.reasons[0]) banner("issue-msg", "error", gate.reasons[0]);
    return;
  }
  const d = state.portal.data;
  const collectorType = $("collector-type").value;
  // A patient collecting their own sample needs no name; whatever was typed before switching is never sent.
  const collectorName = collectorType === "PATIENT" ? "" : $("collector-name").value.trim();
  if (collectorType !== "PATIENT" && !collectorName) {
    banner("issue-msg", "error", "Enter the name of who collected the bottle.");
    $("collector-name").focus();
    return;
  }

  const body = {
    serial,
    investigationRef: d.investigationRef,
    testName: d.testName,
    mrn: d.mrn,
    patientType: d.patientType,
    payment: d.payment,
    collectorType,
    collectorName: collectorName || undefined,
  };
  const extras = siblingItems().filter((s) => state.extra.has(s.investigationRef));
  // The items for this test go with the bottle, unless they were already issued for it.
  const cons = currentConsumables();
  if (cons && !state.consumablesIssued.has(cons.key) && cons.lines.length) {
    const bad = cons.lines.find((l) => !Number.isInteger(l.quantity) || l.quantity < 1);
    if (bad) {
      banner("issue-msg", "error", `Enter a whole number of 1 or more for ${bad.name}, or remove it.`);
      return;
    }
    // No pack is named: the server takes every item first-expiry-first-out.
    body.consumables = cons.lines.map((l) => ({
      itemTypeId: l.itemTypeId,
      quantity: l.quantity,
    }));
  }
  if (extras.length) {
    body.additional = extras.map((s) => ({
      investigationRef: s.investigationRef,
      testName: s.testName,
      patientType: s.patientType || undefined,
      payment: s.payment,
    }));
  }
  const overrideShown = !$("override-wrap").hidden;
  if (overrideShown) {
    const reason = $("override-reason").value.trim();
    if (reason.length < 3) {
      banner("issue-msg", "error", "Enter the reason for the override.");
      $("override-reason").focus();
      return;
    }
    body.override = { reason };
  }

  state.busy = true;
  banner("issue-msg", "info", "Issuing…");
  showBusy("Issuing the bottle…");
  try {
    const res = await api("/api/ext/issue", { method: "POST", body });
    const notes = [];
    if (res.unverified > 0) notes.push("payment could not be verified and is flagged");
    if (res.overridden) notes.push("supervisor override recorded");
    const items = (res.consumables || []).map((l) => (l.inPieces ? `${l.quantity} pieces of ${l.itemName}` : `${l.itemName} x${l.quantity}`));
    banner(
      "issue-msg",
      "ok",
      `Issued ${res.serial} (${res.itemName}) for ${[d.investigationRef, ...extras.map((s) => s.investigationRef)].join(", ")}.${items.length ? ` Items: ${items.join(", ")}.` : ""}${notes.length ? ` Note: ${notes.join("; ")}.` : ""}`,
    );
    beep(true);
    state.lastIssuedSerial = res.serial;
    if (body.consumables) state.consumablesIssued.add(cons.key);
    state.extra.clear();
    for (const ref of [d.investigationRef, ...extras.map((s) => s.investigationRef)]) fetchCollected(ref, true);
    $("print-btn").hidden = false;
    $("issue-scan").value = "";
    $("override-reason").value = "";
    state.forceOverride = false;
    renderGate();
  } catch (err) {
    beep(false);
    banner("issue-msg", "error", err.message);
    // A supervisor can push a blocked issue (wrong container, unpaid) through with a reason.
    if (err instanceof ApiError && err.status === 409 && state.user && state.user.can && state.user.can.override) {
      state.forceOverride = true;
      renderGate();
    }
    $("issue-scan").value = "";
  } finally {
    hideBusy();
    state.busy = false;
    focusScan();
  }
}

/** A loading screen over the whole panel, so the person can see the request is running without scrolling. */
function showBusy(text) {
  $("busy-text").textContent = text || "Please wait…";
  $("busy-overlay").hidden = false;
}

function hideBusy() {
  $("busy-overlay").hidden = true;
}

// The print helper (scripts/print_bridge.py) runs on the computer the label printer is plugged into.
const PRINT_HELPER_URL = "ws://localhost:8767";

/** Sends label commands to the print helper and resolves with how many labels it printed. */
function sendToPrintHelper(tspl) {
  const down =
    "The print helper is not running on this computer. Ask whoever manages this PC to run the print helper installer. " +
    `If it is installed already, it must be set up to allow this extension (extension ID: ${chrome.runtime.id}).`;
  return new Promise((resolve, reject) => {
    let settled = false;
    let socket = null;
    const timer = setTimeout(() => finish(new Error("The print helper did not answer. Check the printer and try again.")), 15000);
    function finish(err, labels = 0) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        if (socket) socket.close();
      } catch {
        /* already closed */
      }
      if (err) reject(err);
      else resolve(labels);
    }
    try {
      socket = new WebSocket(PRINT_HELPER_URL);
    } catch {
      finish(new Error(down));
      return;
    }
    socket.onopen = () => socket.send(JSON.stringify({ type: "print", tspl }));
    socket.onerror = () => finish(new Error(down));
    socket.onclose = () => finish(new Error(down));
    socket.onmessage = (event) => {
      try {
        const reply = JSON.parse(String(event.data));
        if (reply.type === "printed") finish(undefined, reply.labels || 0);
        else finish(new Error(reply.message || "Printing failed"));
      } catch {
        finish(new Error("The print helper gave an answer that could not be read"));
      }
    };
  });
}

async function printLabel() {
  const serial = state.lastIssuedSerial;
  if (!serial) return;
  const button = $("print-btn");
  const idle = button.textContent;
  button.disabled = true;
  button.textContent = "Printing…";
  try {
    const blob = await api(`/api/issues/${encodeURIComponent(serial)}/label?format=tspl`, { as: "blob" });
    await sendToPrintHelper(await blob.text());
    button.textContent = "Label sent to the printer";
    setTimeout(() => {
      button.textContent = idle;
      button.disabled = false;
    }, 2000);
  } catch (err) {
    button.textContent = idle;
    button.disabled = false;
    banner("issue-msg", "error", `Could not print the label: ${err.message}`);
  }
}

// --- return -----------------------------------------------------------------------------------------

async function lookupReturn(serial) {
  if (state.busy) return;
  state.busy = true;
  banner("return-msg", "", "");
  state.unit = null;
  $("outcomes").hidden = true;
  $("unusable-box").hidden = true;
  showBusy("Looking up the bottle…");
  try {
    state.unit = await api(`/api/ext/unit/${encodeURIComponent(serial)}`);
    renderUnit();
    if (state.unit.state !== "ISSUED") {
      beep(false);
      banner(
        "return-msg",
        "error",
        `${state.unit.serial} is ${state.unit.state.toLowerCase().replace(/_/g, " ")}, not issued, so it cannot be returned.`,
      );
    } else {
      $("outcomes").hidden = false;
    }
  } catch (err) {
    beep(false);
    $("unit-card").hidden = true;
    banner("return-msg", "error", err.message);
  } finally {
    hideBusy();
    state.busy = false;
    $("return-scan").value = "";
  }
}

function renderUnit() {
  const u = state.unit;
  const card = $("unit-card");
  card.replaceChildren();
  card.hidden = !u;
  if (!u) return;

  const dl = el("dl", "kv");
  kv(dl, "Bottle", u.serial);
  kv(dl, "Item", u.itemName + (u.containerType ? ` (${u.containerType})` : ""));
  kv(dl, "State", chip(u.state.replace(/_/g, " "), u.state === "ISSUED" ? "ok" : "warn"));
  kv(dl, "At", u.locationName);
  if (u.references.length) {
    kv(dl, "Issued to", u.references.map((r) => r.ref + (r.testCode ? ` (${r.testCode})` : "")).join(", "));
  }
  card.append(dl);

  const page = state.portal && state.portal.ok ? state.portal.data.investigationRef : null;
  if (page && u.state === "ISSUED" && u.references.length) {
    const same = u.references.some((r) => (r.ref || "").toUpperCase() === page);
    card.append(
      same
        ? chip("Belongs to the investigation on this page", "ok")
        : chip(`Not the investigation on this page (${page})`, "warn"),
    );
  }
}

async function loadVoidReasons() {
  if (state.voidReasons) return;
  const data = await api("/api/ext/void-reasons");
  state.voidReasons = data.reasons;
  const select = $("void-reason");
  select.replaceChildren();
  for (const r of state.voidReasons) {
    const opt = el("option", "", r.label);
    opt.value = r.code;
    select.append(opt);
  }
  if (select._refresh) select._refresh();
}

async function doReturn(outcome) {
  if (state.busy || !state.unit) return;
  const body = { serial: state.unit.serial, outcome };
  if (outcome === "UNUSABLE") {
    body.reasonCode = $("void-reason").value;
    if (!body.reasonCode) {
      banner("return-msg", "error", "Choose a reason.");
      return;
    }
    const note = $("return-note").value.trim();
    if (note) body.note = note;
  }
  state.busy = true;
  banner("return-msg", "info", "Saving…");
  showBusy("Saving the return…");
  try {
    const res = await api("/api/ext/return", { method: "POST", body });
    const what = res.became === "RETURNED" ? "marked as used" : res.became === "IN_STOCK" ? "back in stock" : "voided";
    banner("return-msg", "ok", `${res.serial} ${what}.`);
    beep(true);
    // A bottle returned as used or unusable frees the investigation for another bottle, which takes its items
    // with it again; so forget that the items were already issued for it.
    if (outcome === "USED" || outcome === "UNUSABLE") {
      for (const r of state.unit.references || []) {
        const ref = String(r.ref || "").toUpperCase();
        for (const key of [...state.consumablesIssued]) {
          if (key.toUpperCase().startsWith(`${ref}|`)) state.consumablesIssued.delete(key);
        }
      }
      state.consumables = null; // start the items list fresh for the next bottle
    }
    state.unit = null;
    renderUnit();
    state.collected = {};
    renderPortal();
    renderGate();
    $("outcomes").hidden = true;
    $("unusable-box").hidden = true;
    $("return-note").value = "";
  } catch (err) {
    beep(false);
    banner("return-msg", "error", err.message);
  } finally {
    hideBusy();
    state.busy = false;
    focusScan();
  }
}

// --- look up: scan any bottle to see everything about it ---------------------------------------------------

const EVENT_LABEL = {
  STOCKED: "Stocked",
  DISPATCHED: "Dispatched",
  RECEIVED: "Received",
  ISSUED: "Issued",
  USED: "Used",
  RETURNED: "Returned (used)",
  RETURNED_UNUSED: "Returned unused",
  VOIDED: "Voided",
  WASTED: "Wasted",
  ADJUSTED: "Adjusted",
  MISSING_IN_TRANSIT: "Missing in transit",
  FOUND: "Found",
  WRITTEN_OFF: "Written off",
};

const STATUS_CHIP = { pending: ["Pending", "warn"], in_progress: ["In progress", ""], completed: ["Completed", "ok"] };

function fmtTime(value) {
  if (!value) return "";
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleString([], { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

const withBy = (time, by) => fmtTime(time) + (by ? ` by ${by}` : "");

async function lookupBottle(serial) {
  if (state.busy) return;
  state.busy = true;
  banner("lookup-msg", "", "");
  showBusy("Looking up the bottle…");
  try {
    state.lookup = await api(`/api/ext/bottle/${encodeURIComponent(serial)}`);
    renderLookup();
    beep(true);
  } catch (err) {
    state.lookup = null;
    renderLookup();
    beep(false);
    banner("lookup-msg", "error", err.message);
  } finally {
    hideBusy();
    state.busy = false;
    $("lookup-scan").value = "";
    focusScan();
  }
}

/**
 * The portal's id for an investigation (the /lab-tests/<id> in its address). The tracker's copy is used when it
 * has one; otherwise it is found from what this panel has already seen on the portal: the lab queue the portal
 * loaded, the investigation open right now, or one read earlier in this session. That way the link appears
 * even before the tracker has been synced with the id.
 */
function portalIdFor(t) {
  if (t.portalId) return t.portalId;
  if (t.referenceType !== "INVESTIGATION") return null;
  const ref = String(t.ref || "").toUpperCase();
  const queued = state.queueItems.find((it) => it.portalId && String(it.investigationRef || "").toUpperCase() === ref);
  if (queued) return queued.portalId;
  const open = state.portal;
  if (open && open.key && open.data && String(open.data.investigationRef || "").toUpperCase() === ref) return open.key;
  for (const [key, saved] of Object.entries(state.cache)) {
    const data = saved && saved.payload && saved.payload.data;
    if (data && String(data.investigationRef || "").toUpperCase() === ref) return key;
  }
  return null;
}

/**
 * Opens an investigation in the portal. The portal keeps its sign-in in the open tab, so a new tab (or a reload)
 * asks for the login again. So the tab the portal is already open in is moved to the investigation from inside
 * the page, without a reload. A new tab is only the fallback when no portal tab can be reached.
 */
async function openInPortal(portalId) {
  const path = `/lab-tests/${encodeURIComponent(portalId)}`;
  const candidates = [];
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
  if (active && active.id !== undefined) candidates.push(active.id);
  if (state.portalTabId !== null && state.portalTabId !== undefined && !candidates.includes(state.portalTabId)) {
    candidates.push(state.portalTabId);
  }
  for (const id of candidates) {
    try {
      const res = await chrome.tabs.sendMessage(id, { type: "navigate", path });
      if (res && res.ok) {
        state.portalTabId = id;
        await chrome.tabs.update(id, { active: true }).catch(() => {});
        return;
      }
    } catch {
      /* not a portal tab, or the page needs a refresh after the extension was reloaded */
    }
  }
  chrome.tabs.create({ url: `${state.portalOrigin}${path}` });
}

function testCard(t) {
  const card = el("div", "card");
  const name = t.testName || t.testCode;
  card.append(el("div", "test-title", name ? `${t.ref} · ${name}` : t.ref));

  const chips = el("div", "chips");
  const known = t.status ? STATUS_CHIP[t.status] : null;
  if (known) chips.append(chip(known[0], known[1]));
  else chips.append(chip(t.status ? t.status.replace(/_/g, " ") : "Status not recorded", "warn"));
  if (t.paymentCheck === "VERIFIED") chips.append(chip("Payment verified", "ok"));
  else if (t.paymentCheck === "UNVERIFIED") chips.append(chip("Payment not verified", "warn"));
  if (t.overridden) chips.append(chip("Override used", "warn"));
  if (t.clearedAt) chips.append(chip("Link closed", ""));
  card.append(chips);

  const dl = el("dl", "kv");
  if (t.mrn) kv(dl, "Patient no.", t.mrn);
  if (t.patientType) kv(dl, "Raised as", PATIENT_TYPE_LABEL[t.patientType] || t.patientType);
  if (t.invoiceNumber) kv(dl, "Invoice", t.invoiceNumber);
  if (t.destination) kv(dl, "Destination", t.destination);
  const type = t.collectorType ? t.collectorType.charAt(0) + t.collectorType.slice(1).toLowerCase() : "";
  kv(dl, "Collected by", t.collectorType === "PATIENT" ? t.collectorName || "Patient" : [type, t.collectorName].filter(Boolean).join(" · ") || "-");
  kv(dl, "Issued", fmtTime(t.issuedAt));
  if (t.clearedAt) kv(dl, "Closed", fmtTime(t.clearedAt));
  if (t.startedAt) kv(dl, "Started", withBy(t.startedAt, t.startedBy));
  if (t.preparedAt) kv(dl, "Prepared", withBy(t.preparedAt, t.preparedBy));
  if (t.verifiedAt) kv(dl, "Results released", withBy(t.verifiedAt, t.verifiedBy));
  if (t.completedAt) kv(dl, "Completed", fmtTime(t.completedAt));
  card.append(dl);

  const portalId = portalIdFor(t);
  if (portalId && state.portalOrigin) {
    const open = el("button", "", "Open in portal (Results tab)");
    open.addEventListener("click", () => openInPortal(portalId));
    card.append(open);
  } else if (t.referenceType === "INVESTIGATION") {
    card.append(
      el("p", "muted small", "Open this investigation in the portal once, and a link to its page and results will appear here."),
    );
  }
  return card;
}

function renderLookup() {
  const b = state.lookup;
  const card = $("lookup-card");
  const tests = $("lookup-tests");
  const journey = $("lookup-journey");
  for (const node of [card, tests, journey]) {
    node.replaceChildren();
    node.hidden = !b;
  }
  if (!b) return;

  const u = b.unit;
  const dl = el("dl", "kv");
  kv(dl, "Bottle", u.serial);
  kv(dl, "Item", u.itemName + (u.containerType ? ` (${u.containerType})` : ""));
  const bad = u.state === "VOIDED" || u.state === "WRITTEN_OFF" || u.state === "MISSING_IN_TRANSIT";
  kv(dl, "State", chip(u.state.replace(/_/g, " "), u.state === "ISSUED" ? "ok" : bad ? "bad" : ""));
  kv(dl, "Now at", u.locationName);
  if (u.lotNo) kv(dl, "Lot", u.lotNo);
  if (u.expiryDate) kv(dl, "Expires", u.expiryDate);
  card.append(dl);

  tests.append(el("h2", "section-title", b.tests.length ? `Tests this bottle was used for (${b.tests.length})` : "Tests"));
  if (!b.tests.length) tests.append(el("p", "muted small", "This bottle has not been issued for any test."));
  for (const t of b.tests) tests.append(testCard(t));
  if (b.tests.length) {
    tests.append(el("p", "muted small", "Result values are not stored in the tracker. Use Open in portal to read them there."));
  }

  journey.append(el("h2", "section-title", "Where it has been"));
  const ol = el("ol", "timeline");
  for (const s of b.journey) {
    const li = el("li");
    const head = el("div");
    head.append(el("strong", "", EVENT_LABEL[s.type] || s.type.replace(/_/g, " ")), el("span", "muted small", `  ${fmtTime(s.at)}`));
    li.append(head);
    const bits = [s.locationName, s.userName];
    if (s.transferCode) bits.push(`transfer ${s.transferCode}`);
    if (s.reasonCode) bits.push(`reason ${s.reasonCode}`);
    li.append(el("div", "muted small", bits.join(" · ")));
    if (s.note) li.append(el("div", "small", s.note));
    ol.append(li);
  }
  journey.append(ol);
}

// --- scans, from the panel's own input or from the portal page --------------------------------------

function handleScan(code) {
  if ($("view-main").hidden) return;
  if (state.mode === "issue") {
    $("issue-scan").value = code;
    doIssue(code);
  } else if (state.mode === "lookup") {
    $("lookup-scan").value = code;
    lookupBottle(code);
  } else {
    $("return-scan").value = code;
    lookupReturn(code);
  }
}

// --- sign in, settings --------------------------------------------------------------------------------

async function login() {
  const staffId = $("login-staff").value.trim();
  const password = $("login-password").value;
  if (!staffId || !password) return banner("login-msg", "error", "Enter your staff ID and password.");
  $("login-btn").disabled = true;
  banner("login-msg", "info", "Signing in…");
  try {
    const data = await rawFetch("/api/ext/login", { method: "POST", body: { staffId, password } });
    setTokens(data);
    await saveSession();
    $("login-password").value = "";
    banner("login-msg", "", "");
    enterMain();
  } catch (err) {
    banner("login-msg", "error", err.message);
  } finally {
    $("login-btn").disabled = false;
  }
}

async function logout() {
  await clearSession();
  state.testMatches = {};
  state.voidReasons = null;
  state.unit = null;
  showLogin();
}

function openSettings() {
  showView("settings");
  $("settings-base").value = state.baseUrl;
  banner("settings-msg", "", "");
  $("settings-base").focus();
}

function saveSettings() {
  let url;
  try {
    url = new URL($("settings-base").value.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("scheme");
  } catch {
    return banner("settings-msg", "error", "Enter a full address such as https://tracker.hospital.ng");
  }
  if (!isAllowedBase(url)) {
    return banner(
      "settings-msg",
      "error",
      "That address is not allowed. It must start with https:// and be the hospital's approved tracker address (set in the extension's TRACKER_HOSTS list). Plain http is only allowed for localhost.",
    );
  }
  // Must be the first thing that happens in the click handler, so Chrome treats it as a user gesture.
  const granted = chrome.permissions.request({ origins: [`${url.protocol}//${url.hostname}/*`] });
  granted.then(async (ok) => {
    if (!ok) return banner("settings-msg", "error", "Chrome needs your permission to talk to that address.");
    banner("settings-msg", "info", "Testing…");
    try {
      const health = await rawFetch("/api/health", { base: url.origin });
      if (!health || health.ok !== true) throw new ApiError("The server answered, but it does not look like the tracker.", 0);
      const changed = url.origin !== state.baseUrl;
      state.baseUrl = url.origin;
      await chrome.storage.local.set({ baseUrl: state.baseUrl });
      if (changed) await clearSession();
      banner("settings-msg", "ok", "Connected to the tracker.");
      if (changed) setTimeout(() => showLogin(), 700);
    } catch (err) {
      banner("settings-msg", "error", err.message);
    }
  });
}

// --- dropdown ---------------------------------------------------------------------------------------

/**
 * Swaps a native <select> for the app's own dropdown (a button and a list). The <select> stays in the page, hidden,
 * as the source of truth: its value and its "change" event work as before. After changing its options or value
 * from code, call select._refresh(); select._focus() focuses the visible button.
 */
function enhanceSelect(select) {
  if (!select || select._refresh) return;
  select.classList.add("dd-native");
  const wrap = el("div", "dd");
  const button = el("button", "dd-button");
  button.type = "button";
  button.setAttribute("aria-haspopup", "listbox");
  const list = el("ul", "dd-list");
  list.setAttribute("role", "listbox");
  list.hidden = true;
  let active = 0;

  const isOpen = () => !list.hidden;
  function close() {
    list.hidden = true;
    button.setAttribute("aria-expanded", "false");
  }
  function open() {
    active = Math.max(0, select.selectedIndex);
    fill();
    list.hidden = false;
    button.setAttribute("aria-expanded", "true");
    // Open upward when there is not room below (the Reason list sits at the bottom of the panel).
    list.classList.remove("up");
    const room = window.innerHeight - button.getBoundingClientRect().bottom;
    if (room < list.offsetHeight + 8) list.classList.add("up");
    const on = list.querySelector(".on");
    if (on) on.scrollIntoView({ block: "nearest" });
  }
  function pick(index) {
    const option = select.options[index];
    if (!option) return;
    const changed = select.selectedIndex !== index;
    select.selectedIndex = index;
    close();
    refresh();
    if (changed) select.dispatchEvent(new Event("change", { bubbles: true }));
  }
  function fill() {
    list.replaceChildren();
    Array.from(select.options).forEach((option, index) => {
      const li = el("li", index === active ? "dd-item on" : "dd-item", option.textContent);
      li.setAttribute("role", "option");
      if (index === select.selectedIndex) li.classList.add("chosen");
      // mousedown (not click) so the pick lands before the button loses focus
      li.addEventListener("mousedown", (e) => {
        e.preventDefault();
        pick(index);
      });
      list.append(li);
    });
  }
  function refresh() {
    const option = select.options[select.selectedIndex];
    button.replaceChildren(el("span", "dd-value", option ? option.textContent : "Choose…"), el("span", "dd-caret", "▾"));
    if (isOpen()) fill();
  }

  button.addEventListener("click", () => (isOpen() ? close() : open()));
  button.addEventListener("blur", close);
  button.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!isOpen()) return open();
      active = Math.min(Math.max(active + (e.key === "ArrowDown" ? 1 : -1), 0), select.options.length - 1);
      fill();
      const on = list.querySelector(".on");
      if (on) on.scrollIntoView({ block: "nearest" });
    } else if ((e.key === "Enter" || e.key === " ") && isOpen()) {
      e.preventDefault();
      pick(active);
    } else if (e.key === "Escape" && isOpen()) {
      e.preventDefault();
      close();
    }
  });

  wrap.append(button, list);
  select.after(wrap);
  select._refresh = refresh;
  select._focus = () => button.focus();
  refresh();
}

// --- start ------------------------------------------------------------------------------------------

function wire() {
  // The result pop-up closes on OK, a click outside it, Escape, or the next scan being typed.
  $("result-ok").addEventListener("click", () => {
    hideResult();
    focusScan();
  });
  $("result-overlay").addEventListener("click", (e) => {
    if (e.target === $("result-overlay")) {
      hideResult();
      focusScan();
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hideResult();
  });
  for (const id of ["issue-scan", "return-scan", "lookup-scan"]) $(id).addEventListener("input", hideResult);

  // The app's own dropdown instead of the browser's native list.
  enhanceSelect($("collector-type"));
  enhanceSelect($("void-reason"));

  $("login-btn").addEventListener("click", login);
  $("login-password").addEventListener("keydown", (e) => e.key === "Enter" && login());
  $("login-staff").addEventListener("keydown", (e) => e.key === "Enter" && $("login-password").focus());
  $("login-settings").addEventListener("click", openSettings);
  $("open-settings").addEventListener("click", openSettings);
  $("settings-save").addEventListener("click", saveSettings);
  $("settings-back").addEventListener("click", () => (state.tokens ? enterMain() : showLogin()));
  $("signout").addEventListener("click", logout);
  $("refresh-page").addEventListener("click", () => readPage());

  $("tab-issue").addEventListener("click", () => setMode("issue"));
  $("tab-return").addEventListener("click", () => setMode("return"));
  $("tab-lookup").addEventListener("click", () => setMode("lookup"));

  $("collector-type").addEventListener("change", () => {
    if ($("collector-type").value === "PATIENT") $("collector-name").value = "";
    $("collector-name-wrap").hidden = $("collector-type").value === "PATIENT";
    if (!$("collector-name-wrap").hidden) $("collector-name").focus();
  });

  $("issue-scan").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.value.trim()) doIssue(e.target.value.trim());
  });
  $("return-scan").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.value.trim()) lookupReturn(e.target.value.trim());
  });
  $("lookup-scan").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.value.trim()) lookupBottle(e.target.value.trim());
  });
  $("print-btn").addEventListener("click", printLabel);

  $("out-used").addEventListener("click", () => doReturn("USED"));
  $("out-unused").addEventListener("click", () => doReturn("UNUSED"));
  $("out-unusable").addEventListener("click", async () => {
    try {
      await loadVoidReasons();
      $("unusable-box").hidden = false;
      if ($("void-reason")._focus) $("void-reason")._focus();
      else $("void-reason").focus();
    } catch (err) {
      banner("return-msg", "error", err.message);
    }
  });
  $("out-confirm").addEventListener("click", () => doReturn("UNUSABLE"));

  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (!msg || sender.id !== chrome.runtime.id) return;
    const fromActiveTab = sender.tab && sender.tab.id === state.tabId;
    if (msg.type === "portal" && fromActiveTab) setPortal(msg.payload);
    if (msg.type === "scan" && fromActiveTab) handleScan(msg.code);
    if (msg.type === "rows-changed" && fromActiveTab) pullRows();
  });
  chrome.tabs.onActivated.addListener(() => setTimeout(readActiveTab, 150));
  chrome.tabs.onUpdated.addListener((_id, info) => {
    if (info.status === "complete") setTimeout(readActiveTab, 300);
  });
}

async function init() {
  await loadState();
  wire();
  renderPortal();
  if (state.tokens && state.user) enterMain();
  else showLogin();
}

init();
