import { z } from "zod";

// Shared by the forms (client) and the services (server).

export const createTransferSchema = z
  .object({
    fromLocationId: z.uuid(),
    toLocationId: z.uuid(),
    /** The matching Pharmacy transfer, if one exists. Its quantity is read from Pharmacy when it is on file; otherwise it is typed. */
    pharmacyTransferId: z.string().trim().min(1).max(100).optional(),
    pharmacyQuantity: z.number().int().min(0).max(1_000_000).optional(),
    note: z.string().trim().min(1).max(500).optional(),
  })
  .refine((v) => v.fromLocationId !== v.toLocationId, {
    message: "Send to a different location than you send from",
    path: ["toLocationId"],
  })
  .refine((v) => v.pharmacyQuantity === undefined || v.pharmacyTransferId !== undefined, {
    message: "A Pharmacy quantity needs the Pharmacy transfer number it belongs to",
    path: ["pharmacyTransferId"],
  });
export type CreateTransferInput = z.infer<typeof createTransferSchema>;

export const confirmTransferSchema = z.object({
  /** Needed only when the scanned total differs from the linked Pharmacy transfer. */
  explanation: z.string().trim().min(3).max(500).optional(),
  /** Who is carrying the stock. Typed by the store keeper; required, because "who carried it" is the first question when a receipt comes up short. */
  carriedByName: z
    .string({ error: "Enter the name of the person carrying the stock" })
    .trim()
    .min(2, "Enter the name of the person carrying the stock (at least 2 characters)")
    .max(100, "Use at most 100 characters for the carrier's name"),
});
export type ConfirmTransferInput = z.infer<typeof confirmTransferSchema>;

export const resolveDiscrepancySchema = z.object({
  transferItemId: z.uuid(),
  resolution: z.enum(["FOUND", "WRITTEN_OFF"]),
  /** For quantity items: how many. Serialized units are always 1. */
  quantity: z.number().int().positive().max(1_000_000).default(1),
  /** For FOUND only: the location where it turned up. Left out, it goes back in stock at the destination. */
  foundLocationId: z.uuid().optional(),
  /** For FOUND only: what was scanned to prove it. The bottle's serial, or the box label for a bulk batch. Must match the missing item. */
  scannedCode: z.string().trim().max(50).optional(),
  note: z.string().trim().min(3, "A reason is required").max(500),
});
export type ResolveDiscrepancyInput = z.infer<typeof resolveDiscrepancySchema>;

/** Human wording for statuses, shared by pages. */
export const TRANSFER_STATUS_LABEL: Record<string, string> = {
  DRAFT: "Draft",
  DISPATCHED: "On its way",
  RECEIVING: "Being received",
  RECEIVED: "Received",
  RECEIVED_WITH_DISCREPANCY: "Received with discrepancy",
  DISCREPANCY_RESOLVED: "Discrepancy resolved",
  CANCELLED: "Cancelled",
};
