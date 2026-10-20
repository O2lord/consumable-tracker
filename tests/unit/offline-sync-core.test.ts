import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BATCH_SIZE, backoffMs, chunk, planResults, summarize, toWire, type QueuedEvent } from "@/offline/sync-core";
import { clampOccurredAt, MAX_FUTURE_MS } from "@/lib/sync-time";
import { MAX_SYNC_BATCH, syncEventSchema, syncRequestSchema, type SyncResult } from "@/types/sync";

const USER = randomUUID();
const OTHER = randomUUID();

const queued = (over: Partial<QueuedEvent> = {}): QueuedEvent => ({
  id: randomUUID(),
  kind: "RECEIVE_UNIT",
  transferId: randomUUID(),
  transferCode: "TRF123",
  serial: "CT12345678A",
  userId: USER,
  occurredAt: "2026-10-07T08:00:00.000Z",
  deviceId: "TABLET-1",
  status: "PENDING",
  attempts: 0,
  ...over,
});

describe("backoffMs", () => {
  it("doubles from two seconds and stops at a minute", () => {
    expect([0, 1, 2, 3, 4, 5].map((n) => backoffMs(n))).toEqual([2000, 4000, 8000, 16000, 32000, 60000]);
    expect(backoffMs(50)).toBe(60000);
  });

  it("never goes below the base, whatever it is given", () => {
    expect(backoffMs(-3)).toBe(2000);
    expect(backoffMs(1.9)).toBe(4000);
  });
});

describe("chunk", () => {
  it("splits into batches of at most the size, keeping order", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 2)).toEqual([]);
  });

  it("keeps a batch within what the server accepts", () => {
    expect(BATCH_SIZE).toBeLessThanOrEqual(MAX_SYNC_BATCH);
  });
});

describe("toWire", () => {
  it("sends only what the server needs, nothing local to the device", () => {
    const e = queued({ message: "old", attempts: 3 });
    const wire = toWire(e);
    expect(Object.keys(wire).sort()).toEqual(["deviceId", "id", "kind", "occurredAt", "serial", "transferId", "userId"]);
    expect(syncEventSchema.safeParse(wire).success).toBe(true);
  });
});

describe("planResults", () => {
  const result = (id: string, status: SyncResult["status"], message = ""): SyncResult => ({ id, status, message });

  it("drops what was applied or already applied", () => {
    const a = queued();
    const b = queued();
    const plan = planResults([a.id, b.id], [result(a.id, "OK"), result(b.id, "DUPLICATE")]);
    expect(plan.remove).toEqual([a.id, b.id]);
    expect(plan.rejected).toEqual([]);
    expect(plan.retry).toEqual([]);
  });

  it("keeps a refused scan, with the reason, for the needs-attention list", () => {
    const a = queued();
    const plan = planResults([a.id], [result(a.id, "REJECTED", "Cannot receive items: this transfer is received")]);
    expect(plan.remove).toEqual([]);
    expect(plan.rejected).toEqual([{ id: a.id, message: "Cannot receive items: this transfer is received" }]);
  });

  it("keeps held and failed scans to try again, and treats a missing answer as a retry", () => {
    const held = queued();
    const failed = queued();
    const silent = queued();
    const plan = planResults(
      [held.id, failed.id, silent.id],
      [result(held.id, "HOLD", "other user"), result(failed.id, "RETRY")],
    );
    expect(plan.held).toEqual([{ id: held.id, message: "other user" }]);
    expect(plan.retry.sort()).toEqual([failed.id, silent.id].sort());
    expect(plan.remove).toEqual([]);
  });

  it("ignores answers for scans that were not sent", () => {
    const a = queued();
    const plan = planResults([a.id], [result(a.id, "OK"), result(randomUUID(), "OK")]);
    expect(plan.remove).toEqual([a.id]);
  });
});

describe("summarize", () => {
  it("counts waiting, held for another user, and refused", () => {
    const events = [
      queued(),
      queued(),
      queued({ userId: OTHER }),
      queued({ status: "REJECTED" }),
      queued({ status: "REJECTED", userId: OTHER }),
    ];
    expect(summarize(events, USER)).toEqual({ pending: 3, held: 1, rejected: 2 });
  });

  it("holds nothing while it does not yet know who is signed in", () => {
    expect(summarize([queued({ userId: OTHER })], null)).toEqual({ pending: 1, held: 0, rejected: 0 });
  });
});

describe("clampOccurredAt", () => {
  const now = new Date("2026-10-07T12:00:00.000Z");

  it("keeps a device time in the past, however old", () => {
    const old = new Date("2026-10-01T09:00:00.000Z");
    expect(clampOccurredAt(old, now)).toEqual({ at: old, skewed: false });
  });

  it("allows a little drift into the future", () => {
    const near = new Date(now.getTime() + MAX_FUTURE_MS - 1000);
    expect(clampOccurredAt(near, now)).toEqual({ at: near, skewed: false });
  });

  it("pulls a time further in the future back to the server's, and flags it", () => {
    const far = new Date(now.getTime() + MAX_FUTURE_MS + 1000);
    expect(clampOccurredAt(far, now)).toEqual({ at: now, skewed: true });
  });

  it("treats an unreadable time as skewed", () => {
    expect(clampOccurredAt(new Date("nonsense"), now)).toEqual({ at: now, skewed: true });
  });
});

describe("sync request schema", () => {
  const valid = () => toWire(queued());

  it("accepts a well-formed batch", () => {
    expect(syncRequestSchema.safeParse({ events: [valid(), valid()] }).success).toBe(true);
  });

  it("rejects an empty batch, an oversized one, and malformed events", () => {
    expect(syncRequestSchema.safeParse({ events: [] }).success).toBe(false);
    expect(syncRequestSchema.safeParse({ events: Array.from({ length: MAX_SYNC_BATCH + 1 }, valid) }).success).toBe(false);
    expect(syncRequestSchema.safeParse({ events: [{ ...valid(), id: "not-a-uuid" }] }).success).toBe(false);
    expect(syncRequestSchema.safeParse({ events: [{ ...valid(), kind: "ISSUE_UNIT" }] }).success).toBe(false);
    expect(syncRequestSchema.safeParse({ events: [{ ...valid(), occurredAt: "yesterday" }] }).success).toBe(false);
    expect(syncRequestSchema.safeParse({ events: [{ ...valid(), serial: "" }] }).success).toBe(false);
  });

  it("accepts a device time with a timezone offset", () => {
    expect(syncEventSchema.safeParse({ ...valid(), occurredAt: "2026-10-07T09:30:00+01:00" }).success).toBe(true);
  });
});
