import "server-only";
import { asc, eq } from "drizzle-orm";
import type { DbOrTx } from "../audit/events";
import { cartons } from "../db/schema";
import { generateCartonCode } from "../../lib/serial";

// A carton is one physical outer box with its own barcode (CN...). Like a pack, it only gives identity and
// containment: the batch ledger stays the authority on stock. See 20261026000100_cartons.sql.

export interface CartonRef {
  id: string;
  code: string;
}

/**
 * Makes `count` carton rows for a batch, each recording what it held when received. Returns them in creation order, so
 * the caller can hand the first carton's worth of packs or bottles to the first row, and so on.
 */
export async function createCartonsForBatch(
  tx: DbOrTx,
  input: {
    batchId: string;
    itemTypeId: string;
    deliveryId: string | null;
    locationId: string;
    count: number;
    /** Packs (or the items themselves, when there is no pack level) in each carton. */
    packsCount: number;
    /** Pieces in each carton. */
    piecesCount: number;
  },
): Promise<CartonRef[]> {
  const codeSet = new Set<string>();
  while (codeSet.size < input.count) codeSet.add(generateCartonCode());
  const codes = [...codeSet];

  const rows = await tx
    .insert(cartons)
    .values(
      codes.map((code) => ({
        code,
        batchId: input.batchId,
        itemTypeId: input.itemTypeId,
        deliveryId: input.deliveryId,
        locationId: input.locationId,
        packsCount: input.packsCount,
        piecesCount: input.piecesCount,
      })),
    )
    .returning({ id: cartons.id, code: cartons.code });
  // Insert order is not guaranteed to come back in order, so put them back in the order the codes were made.
  const byCode = new Map(rows.map((r) => [r.code, r] as const));
  return codes.map((code) => byCode.get(code)!);
}

/** Carton codes of one batch, in code order. Empty for batches not received in cartons. */
export async function listCartonCodes(conn: DbOrTx, batchId: string): Promise<string[]> {
  const rows = await conn.select({ code: cartons.code }).from(cartons).where(eq(cartons.batchId, batchId)).orderBy(asc(cartons.code));
  return rows.map((r) => r.code);
}
