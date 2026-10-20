import { z } from "zod";

export const MAX_SERIAL_BATCH = 5000;

// Shared by the stock-in form (client) and the API/service (server).
export const stockInInputSchema = z.object({
  itemTypeId: z.uuid(),
  /** Must be a STORE location. */
  locationId: z.uuid(),
  /** Number of units (SERIAL items get this many serials; QUANTITY items record this quantity). */
  quantity: z.number().int().positive().max(100_000),
  lotNo: z.string().trim().min(1).max(100).optional(),
  /** YYYY-MM-DD */
  expiryDate: z.iso.date().optional(),
  supplier: z.string().trim().min(1).max(200).optional(),
  deviceId: z.string().max(100).optional(),
});

export type StockInInput = z.infer<typeof stockInInputSchema>;
