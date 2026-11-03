import { z } from "zod";
import { RECEIVE_ENTRIES } from "../lib/pack-size";

export const MAX_SERIAL_BATCH = 5000;

// Shared by the stock-in form (client) and the API/service (server).
export const stockInInputSchema = z.object({
  itemTypeId: z.uuid(),
  /** Must be a STORE location. */
  locationId: z.uuid(),
  /**
   * How many were counted, in `entry` (cartons, packs or pieces). Without `entry` it is in the item's own stock unit:
   * SERIAL items get this many serials; QUANTITY items record this quantity.
   */
  quantity: z.number().int().positive().max(100_000),
  /** What `quantity` counts. Leave out to count in the item's own unit, with no cartons (the old behaviour). */
  entry: z.enum(RECEIVE_ENTRIES).optional(),
  lotNo: z.string().trim().min(1).max(100).optional(),
  /** YYYY-MM-DD */
  expiryDate: z.iso.date().optional(),
  supplier: z.string().trim().min(1).max(200).optional(),
  deviceId: z.string().max(100).optional(),
});

export type StockInInput = z.infer<typeof stockInInputSchema>;
