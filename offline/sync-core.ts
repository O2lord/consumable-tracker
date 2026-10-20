// The pure parts of the offline queue: batching, backoff, and what to do with the server's reply.
// No browser APIs here, so it is unit-tested directly (tests/unit/offline-sync-core.test.ts).

import type { SyncEvent, SyncEventKind, SyncResult } from "../types/sync";

export interface QueuedEvent {
  /** Generated on the device when the scan happens. The server applies each id at most once. */
  id: string;
  kind: SyncEventKind;
  transferId: string;
  /** Only for showing the person which slip a scan belonged to. */
  transferCode: string;
  serial: string;
  /** Who scanned. Only that person's session can send it. */
  userId: string;
  /** Device time of the scan (ISO). */
  occurredAt: string;
  deviceId: string;
  /** PENDING: waiting to be sent. REJECTED: the server refused it; it stays until someone dismisses it. */
  status: "PENDING" | "REJECTED";
  attempts: number;
  /** Why it was rejected, or why it is on hold. */
  message?: string;
}

export const BATCH_SIZE = 50;

/** 2s, 4s, 8s ... up to a minute, so a dead connection is not hammered. `attempts` starts at 0. */
export function backoffMs(attempts: number, baseMs = 2_000, capMs = 60_000): number {
  const n = Math.max(0, Math.floor(attempts));
  return Math.min(capMs, baseMs * 2 ** Math.min(n, 20));
}

export function chunk<T>(items: readonly T[], size = BATCH_SIZE): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Exactly what goes over the wire: nothing local to the device. */
export function toWire(event: QueuedEvent): SyncEvent {
  return {
    id: event.id,
    kind: event.kind,
    transferId: event.transferId,
    serial: event.serial,
    userId: event.userId,
    occurredAt: event.occurredAt,
    deviceId: event.deviceId,
  };
}

export interface ResultPlan {
  /** Applied (or already applied): drop them from the queue. */
  remove: string[];
  /** Refused by the server: keep them, flagged, for the needs-attention list. */
  rejected: { id: string; message: string }[];
  /** Not processed under this sign-in: keep them waiting. */
  held: { id: string; message: string }[];
  /** Server trouble, or no answer for them at all: keep them and try again. */
  retry: string[];
}

/** Sorts the server's reply into what to do with each event that was sent. */
export function planResults(sent: readonly string[], results: readonly SyncResult[]): ResultPlan {
  const byId = new Map(results.map((r) => [r.id, r]));
  const plan: ResultPlan = { remove: [], rejected: [], held: [], retry: [] };
  for (const id of sent) {
    const r = byId.get(id);
    if (!r) plan.retry.push(id);
    else if (r.status === "OK" || r.status === "DUPLICATE") plan.remove.push(id);
    else if (r.status === "REJECTED") plan.rejected.push({ id, message: r.message });
    else if (r.status === "HOLD") plan.held.push({ id, message: r.message });
    else plan.retry.push(id);
  }
  return plan;
}

export interface QueueSummary {
  /** Waiting to be sent (includes held). */
  pending: number;
  /** Waiting for someone else to sign in. */
  held: number;
  /** Refused by the server, needing a person to look. */
  rejected: number;
}

export function summarize(events: readonly QueuedEvent[], sessionUserId: string | null): QueueSummary {
  let pending = 0;
  let held = 0;
  let rejected = 0;
  for (const e of events) {
    if (e.status === "REJECTED") rejected += 1;
    else {
      pending += 1;
      if (sessionUserId && e.userId !== sessionUserId) held += 1;
    }
  }
  return { pending, held, rejected };
}
