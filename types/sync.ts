import { z } from "zod";

// What the offline queue sends to POST /api/events, and what comes back. Shared by the browser
// (offline/*) and the server (sync.service.ts), so the two cannot drift apart.

/** The kinds of scan that can be queued. Receiving a bottle is the one that matters on a dead-Wi-Fi ward. */
export const SYNC_EVENT_KINDS = ["RECEIVE_UNIT"] as const;
export type SyncEventKind = (typeof SYNC_EVENT_KINDS)[number];

export const syncEventSchema = z.object({
  /** Generated on the device when the scan happens; makes delivery idempotent. */
  id: z.uuid(),
  kind: z.enum(SYNC_EVENT_KINDS),
  transferId: z.uuid(),
  serial: z.string().trim().min(1).max(60),
  /** Who scanned. A scan is only accepted from that same person's session. */
  userId: z.uuid(),
  /** Device time of the scan. */
  occurredAt: z.iso.datetime({ offset: true }),
  deviceId: z.string().trim().min(1).max(100),
});
export type SyncEvent = z.infer<typeof syncEventSchema>;

export const MAX_SYNC_BATCH = 100;

export const syncRequestSchema = z.object({
  events: z.array(syncEventSchema).min(1).max(MAX_SYNC_BATCH),
});

/**
 *  OK         the scan was applied
 *  DUPLICATE  already applied (a retry, or the same bottle scanned twice): nothing more to do
 *  REJECTED   no longer valid against current state: the person must look at it
 *  HOLD       cannot be processed under this sign-in (another user scanned it): keep it
 *  RETRY      the server had a problem: keep it and try again
 */
export const SYNC_RESULT_STATUSES = ["OK", "DUPLICATE", "REJECTED", "HOLD", "RETRY"] as const;
export type SyncResultStatus = (typeof SYNC_RESULT_STATUSES)[number];

export interface SyncResult {
  id: string;
  status: SyncResultStatus;
  message: string;
}
