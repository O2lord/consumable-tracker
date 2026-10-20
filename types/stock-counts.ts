import { z } from "zod";
import { PAR_QUANTITY_MAX } from "../server/domain/types";

// Shared by the forms (client) and the services (server). Corrections C7.

/** One row of the target-stock form. A null target means "no target for this item here" (any par level is removed). */
export const parRowSchema = z
  .object({
    itemTypeId: z.uuid(),
    target: z.number().int("Enter a whole number").min(1, "The target must be at least 1").max(PAR_QUANTITY_MAX).nullable(),
    minimum: z.number().int("Enter a whole number").min(0).max(PAR_QUANTITY_MAX),
  })
  .refine((v) => v.target === null || v.minimum <= v.target, {
    message: "The minimum cannot be higher than the target",
    path: ["minimum"],
  });
export type ParRowInput = z.infer<typeof parRowSchema>;

export const saveParLevelsSchema = z.object({
  locationId: z.uuid(),
  rows: z
    .array(parRowSchema)
    .min(1)
    .max(500)
    .refine((rows) => new Set(rows.map((r) => r.itemTypeId)).size === rows.length, {
      message: "Each item can appear only once",
    }),
});
export type SaveParLevelsInput = z.infer<typeof saveParLevelsSchema>;

/**
 * Submitting a count: counted quantities per batch. Batches left out are simply not counted. A batch can be counted
 * in sealed packs (`counted`), in loose pieces (`countedPieces`), or both; at least one is needed per line.
 */
export const submitCountSchema = z.object({
  locationId: z.uuid().optional(),
  note: z.string().trim().min(1).max(500).optional(),
  lines: z
    .array(
      z
        .object({
          batchId: z.uuid(),
          counted: z.number().int("Enter a whole number").min(0, "A count cannot be negative").max(10_000_000).nullish(),
          countedPieces: z
            .number()
            .int("Enter a whole number")
            .min(0, "A count cannot be negative")
            .max(10_000_000)
            .nullish(),
        })
        .refine((l) => l.counted != null || l.countedPieces != null, {
          message: "Enter sealed packs, loose pieces, or both",
        }),
    )
    .min(1, "Count at least one item")
    .max(500)
    .refine((lines) => new Set(lines.map((l) => l.batchId)).size === lines.length, {
      message: "Each batch can appear only once",
    }),
});
export type SubmitCountInput = z.infer<typeof submitCountSchema>;

/**
 * Posting a count: the reason (and optional note) for each line that has a variance. Sealed packs and loose pieces
 * are explained separately, because one can be short while the other is over (a pack opened and not recorded).
 */
export const postCountSchema = z.object({
  lines: z
    .array(
      z.object({
        lineId: z.uuid(),
        reasonCode: z.string().trim().max(50).nullable().optional(),
        note: z.string().trim().max(300).nullable().optional(),
        piecesReasonCode: z.string().trim().max(50).nullable().optional(),
        piecesNote: z.string().trim().max(300).nullable().optional(),
      }),
    )
    .max(500),
});
export type PostCountInput = z.infer<typeof postCountSchema>;

export const COUNT_STATUS_LABEL: Record<string, string> = {
  OPEN: "Waiting to be posted",
  POSTED: "Posted",
  CANCELLED: "Cancelled",
};
