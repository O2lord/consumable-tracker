// The sync loop: send queued scans to POST /api/events, retry with backoff, and keep a small store
// the UI reads (offline/use-sync-state.ts). Browser-only.
//
// A scan is saved on the device FIRST, then sent. If the send succeeds right away the person gets the
// server's answer for that scan; if not, it stays queued and is sent when the connection returns.
// The server applies each scan at most once (by its id) and re-checks it against the current state.

import type { SyncEvent, SyncResult } from "../types/sync";
import { getDeviceId } from "./device";
import { isQueueSupported, listEvents, putEvent, QUEUE_CHANGED, removeEvents } from "./queue";
import {
  BATCH_SIZE,
  backoffMs,
  chunk,
  planResults,
  summarize,
  toWire,
  type QueuedEvent,
  type QueueSummary,
} from "./sync-core";

// --- state the UI reads --------------------------------------------------------

export interface SyncState {
  online: boolean;
  syncing: boolean;
  /** The server said the sign-in has ended: scans are kept and sent after signing in again. */
  authRequired: boolean;
  sessionUserId: string | null;
  events: QueuedEvent[];
  summary: QueueSummary;
}

// What the server render and the first client render both show, so they cannot disagree.
const SERVER_STATE: SyncState = {
  online: true,
  syncing: false,
  authRequired: false,
  sessionUserId: null,
  events: [],
  summary: { pending: 0, held: 0, rejected: 0 },
};

let state: SyncState = SERVER_STATE;
const listeners = new Set<() => void>();

function setState(patch: Partial<Omit<SyncState, "summary">>) {
  const next = { ...state, ...patch };
  state = { ...next, summary: summarize(next.events, next.sessionUserId) };
  for (const listener of listeners) listener();
}

export function subscribeSync(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export const getSyncSnapshot = (): SyncState => state;
export const getServerSnapshot = (): SyncState => SERVER_STATE;

async function reload() {
  if (!isQueueSupported()) return;
  try {
    setState({ events: await listEvents() });
  } catch {
    // An unreadable queue must not break the page; the indicator just shows nothing waiting.
  }
}

/** Tells the loop who is signed in, so only that person's scans are sent under that sign-in. */
export function setSessionUser(userId: string | null) {
  if (state.sessionUserId === userId) return;
  setState({ sessionUserId: userId });
  void syncNow();
}

// --- talking to the server -----------------------------------------------------

type PostOutcome = { kind: "results"; results: SyncResult[] } | { kind: "auth" } | { kind: "down" };

async function post(events: SyncEvent[]): Promise<PostOutcome> {
  let response: Response;
  try {
    response = await fetch("/api/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ events }),
    });
  } catch {
    return { kind: "down" };
  }
  if (response.status === 401 || response.status === 403) return { kind: "auth" };
  if (!response.ok) return { kind: "down" };
  try {
    const body = (await response.json()) as { results?: SyncResult[] };
    return { kind: "results", results: body.results ?? [] };
  } catch {
    return { kind: "down" };
  }
}

// --- the loop -------------------------------------------------------------------

/** The server's answer for scans sent recently, so submitScan can show it for the scan just made. */
const recent = new Map<string, SyncResult>();
function remember(results: readonly SyncResult[]) {
  for (const r of results) recent.set(r.id, r);
  while (recent.size > 200) {
    const oldest = recent.keys().next().value;
    if (oldest === undefined) break;
    recent.delete(oldest);
  }
}

let retryTimer: number | null = null;
function scheduleRetry(attempts: number) {
  if (retryTimer !== null) return;
  retryTimer = window.setTimeout(() => {
    retryTimer = null;
    void syncNow();
  }, backoffMs(attempts));
}

async function bumpAttempts(events: readonly QueuedEvent[]) {
  for (const e of events) await putEvent({ ...e, attempts: e.attempts + 1 });
}

async function applyResults(part: readonly QueuedEvent[], results: readonly SyncResult[]) {
  remember(results);
  const plan = planResults(
    part.map((e) => e.id),
    results,
  );
  const byId = new Map(part.map((e) => [e.id, e]));

  await removeEvents(plan.remove);
  for (const r of plan.rejected) {
    const e = byId.get(r.id);
    if (e) await putEvent({ ...e, status: "REJECTED", message: r.message });
  }
  for (const r of plan.held) {
    const e = byId.get(r.id);
    if (e) await putEvent({ ...e, message: r.message });
  }
  const retry = plan.retry.map((id) => byId.get(id)).filter((e): e is QueuedEvent => Boolean(e));
  if (retry.length > 0) {
    await bumpAttempts(retry);
    scheduleRetry(Math.max(...retry.map((e) => e.attempts + 1)));
  }
}

async function run() {
  if (!isQueueSupported() || !navigator.onLine) return;
  let all: QueuedEvent[];
  try {
    all = await listEvents();
  } catch {
    return;
  }
  setState({ events: all });

  const mine = all.filter(
    (e) => e.status === "PENDING" && (state.sessionUserId === null || e.userId === state.sessionUserId),
  );
  if (mine.length === 0) {
    if (state.authRequired) setState({ authRequired: false });
    return;
  }

  setState({ syncing: true });
  try {
    for (const part of chunk(mine, BATCH_SIZE)) {
      const outcome = await post(part.map(toWire));
      if (outcome.kind === "auth") {
        setState({ authRequired: true });
        break;
      }
      if (outcome.kind === "down") {
        await bumpAttempts(part);
        scheduleRetry(Math.max(...part.map((e) => e.attempts + 1)));
        break;
      }
      setState({ authRequired: false });
      await applyResults(part, outcome.results);
    }
  } finally {
    await reload();
    setState({ syncing: false });
  }
}

let inFlight: Promise<void> | null = null;

/** Sends whatever is waiting. Safe to call at any time: a run already in progress is shared. */
export function syncNow(): Promise<void> {
  inFlight ??= run().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

let started = false;

/** Starts the background sync once per page: on reconnect, on returning to the tab, and every 30s. */
export function startAutoSync() {
  if (started || typeof window === "undefined") return;
  started = true;

  setState({ online: navigator.onLine });
  window.addEventListener("online", () => {
    setState({ online: true });
    void syncNow();
  });
  window.addEventListener("offline", () => setState({ online: false }));
  window.addEventListener(QUEUE_CHANGED, () => void reload());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void syncNow();
  });
  window.setInterval(() => void syncNow(), 30_000);

  void reload().then(() => syncNow());
}

// --- scanning -------------------------------------------------------------------

export interface ScanSubmitResult {
  /** `queued`: saved on this device and not yet checked by the server. */
  kind: "ok" | "duplicate" | "error" | "queued";
  message: string;
}

function toScanResult(result: SyncResult, serial: string): ScanSubmitResult {
  switch (result.status) {
    case "OK":
      return { kind: "ok", message: result.message };
    case "DUPLICATE":
      return { kind: "duplicate", message: result.message };
    case "REJECTED":
      return { kind: "error", message: result.message };
    default:
      return {
        kind: "queued",
        message: `${serial} saved on this device. It will be sent and checked when the connection allows`,
      };
  }
}

/**
 * One bottle scanned at the destination. It is saved on the device first; if the connection is up the
 * server's answer comes back immediately, otherwise it waits in the queue.
 */
export async function submitScan(input: {
  transferId: string;
  transferCode: string;
  serial: string;
  userId: string;
}): Promise<ScanSubmitResult> {
  const serial = input.serial.trim();
  if (!serial) return { kind: "error", message: "Scan a bottle label" };

  const key = serial.toUpperCase();
  const waiting = state.events.some(
    (e) => e.status === "PENDING" && e.transferId === input.transferId && e.serial.toUpperCase() === key,
  );
  if (waiting) {
    return { kind: "duplicate", message: `${serial} was already scanned on this device and is waiting to be sent` };
  }

  const event: QueuedEvent = {
    id: crypto.randomUUID(),
    kind: "RECEIVE_UNIT",
    transferId: input.transferId,
    transferCode: input.transferCode,
    serial,
    userId: input.userId,
    occurredAt: new Date().toISOString(),
    deviceId: getDeviceId(),
    status: "PENDING",
    attempts: 0,
  };

  // A browser that cannot keep a queue can still scan while the connection is up.
  if (!isQueueSupported()) {
    const outcome = await post([toWire(event)]);
    const result = outcome.kind === "results" ? outcome.results.find((r) => r.id === event.id) : undefined;
    return result
      ? toScanResult(result, serial)
      : { kind: "error", message: "Could not reach the server, and this browser cannot save scans offline. Scan again when connected" };
  }

  try {
    await putEvent(event);
  } catch {
    return { kind: "error", message: "Could not save that scan on this device. Scan it again" };
  }

  if (navigator.onLine) {
    await syncNow();
    // A run that was already going may have started before this scan was saved.
    if (!recent.has(event.id)) await syncNow();
  }

  const result = recent.get(event.id);
  recent.delete(event.id);
  if (!result) {
    return {
      kind: "queued",
      message: `${serial} saved on this device. It will be sent and checked when the connection returns`,
    };
  }
  // The person is looking at this answer right now, so a refusal does not also need to sit on the
  // needs-attention list.
  if (result.status === "REJECTED") await removeEvents([event.id]);
  return toScanResult(result, serial);
}

/** Removes a scan from the needs-attention list once someone has dealt with it. */
export async function dismissEvent(id: string): Promise<void> {
  await removeEvents([id]);
}
