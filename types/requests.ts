import { z } from "zod";

// Shared by the forms (client) and the services (server).

const lineSchema = z.object({
  itemTypeId: z.uuid(),
  quantity: z.number().int("Enter a whole number").min(1, "Enter at least 1").max(1_000_000),
  /** True when `quantity` counts loose pieces of a pack item rather than the item's own unit. */
  inPieces: z.boolean().optional().default(false),
});

/** One line per item type: the same item twice on a request is almost always a slip. */
function distinctItems<T extends { itemTypeId: string }>(lines: readonly T[]): boolean {
  return new Set(lines.map((l) => l.itemTypeId)).size === lines.length;
}

export const requestLinesSchema = z
  .array(lineSchema)
  .min(1, "Add at least one item")
  .max(50, "A request can have at most 50 items")
  .refine(distinctItems, { message: "Each item can appear only once on a request" });

export const createRequestSchema = z
  .object({
    requestingLocationId: z.uuid(),
    storeLocationId: z.uuid(),
    note: z.string().trim().min(1).max(500).optional(),
    lines: requestLinesSchema,
  })
  .refine((v) => v.requestingLocationId !== v.storeLocationId, {
    message: "Ask a different location than your own",
    path: ["storeLocationId"],
  });
export type CreateRequestInput = z.infer<typeof createRequestSchema>;

/** Editing a draft replaces its note and lines. The locations are changed separately (see below). */
export const updateDraftRequestSchema = z.object({
  note: z.string().trim().min(1).max(500).nullable().optional(),
  lines: requestLinesSchema,
});
export type UpdateDraftRequestInput = z.infer<typeof updateDraftRequestSchema>;

/** Moving a draft to another store, or another requesting location. Leave one out to keep it as it is. */
export const updateDraftLocationsSchema = z.object({
  requestingLocationId: z.uuid().optional(),
  storeLocationId: z.uuid().optional(),
});
export type UpdateDraftLocationsInput = z.infer<typeof updateDraftLocationsSchema>;

/** Approving: how much of each line the store agrees to send (0 declines that line). */
export const approveRequestSchema = z
  .object({
    lines: z
      .array(
        z.object({
          lineId: z.uuid(),
          quantityApproved: z.number().int("Enter a whole number").min(0).max(1_000_000),
        }),
      )
      .min(1),
    reviewNote: z.string().trim().min(1).max(500).optional(),
  })
  .refine((v) => new Set(v.lines.map((l) => l.lineId)).size === v.lines.length, {
    message: "Each line can appear only once",
    path: ["lines"],
  });
export type ApproveRequestInput = z.infer<typeof approveRequestSchema>;

export const rejectRequestSchema = z.object({
  reviewNote: z.string().trim().min(3, "Say why the request is rejected").max(500),
});
export type RejectRequestInput = z.infer<typeof rejectRequestSchema>;

export const closeRequestLineSchema = z.object({
  reason: z.string().trim().min(3, "A reason is required to close a line").max(500),
});
export type CloseRequestLineInput = z.infer<typeof closeRequestLineSchema>;

/** Human wording for statuses, shared by pages. */
export const REQUEST_STATUS_LABEL: Record<string, string> = {
  DRAFT: "Draft",
  SUBMITTED: "Waiting for the store",
  APPROVED: "Approved",
  REJECTED: "Rejected",
  PARTIALLY_FULFILLED: "Partially fulfilled",
  FULFILLED: "Fulfilled",
  CLOSED: "Closed",
  CANCELLED: "Cancelled",
};
