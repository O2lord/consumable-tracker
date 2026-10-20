import "server-only";
import { and, eq, inArray, ne, sql, sum } from "drizzle-orm";
import { transferItems, transfers } from "../schema";
import type { DbOrTx } from "../../audit/events";

/** On-hand quantity of one batch at one location, derived from the ledger (v_quantity_balance). */
export async function quantityOnHand(conn: DbOrTx, batchId: string, locationId: string): Promise<number> {
  const rows = await conn.execute<{ on_hand: number }>(
    sql`select on_hand from consumables.v_quantity_balance where batch_id = ${batchId} and location_id = ${locationId}`,
  );
  return rows[0]?.on_hand ?? 0;
}

/**
 * Loose pieces of one batch at one location (v_loose_pieces): pieces of opened packs, not counted in the sealed
 * balance above. Zero when no pack of this batch was ever opened there.
 */
export async function quantityLoose(conn: DbOrTx, batchId: string, locationId: string): Promise<number> {
  const rows = await conn.execute<{ loose: number }>(
    sql`select loose from consumables.v_loose_pieces where batch_id = ${batchId} and location_id = ${locationId}`,
  );
  return rows[0]?.loose ?? 0;
}

/**
 * Quantity issued from a location and not yet returned or written off through the return flow
 * (v_quantity_issued_outstanding). A return can never be larger than this.
 */
export async function quantityIssuedOutstanding(conn: DbOrTx, batchId: string, locationId: string): Promise<number> {
  const rows = await conn.execute<{ outstanding: number }>(
    sql`select outstanding from consumables.v_quantity_issued_outstanding where batch_id = ${batchId} and location_id = ${locationId}`,
  );
  return rows[0]?.outstanding ?? 0;
}

/**
 * Whole packs of a batch already promised to OTHER draft transfers leaving the same location.
 * Dispatched transfers are not counted: their DISPATCHED events already left the balance. Draft lines counted in
 * pieces are not packs, so they are left out here (see quantityReservedPiecesByDrafts).
 */
export async function quantityReservedByDrafts(
  conn: DbOrTx,
  batchId: string,
  fromLocationId: string,
  exceptTransferId: string,
): Promise<number> {
  const [row] = await conn
    .select({ total: sum(transferItems.quantityDispatched) })
    .from(transferItems)
    .innerJoin(transfers, eq(transfers.id, transferItems.transferId))
    .where(
      and(
        eq(transferItems.batchId, batchId),
        eq(transferItems.inPieces, false),
        eq(transfers.fromLocationId, fromLocationId),
        inArray(transfers.status, ["DRAFT"]),
        ne(transfers.id, exceptTransferId),
      ),
    );
  return Number(row?.total ?? 0);
}

/** Loose pieces of a batch already promised to OTHER draft transfers leaving the same location. */
export async function quantityReservedPiecesByDrafts(
  conn: DbOrTx,
  batchId: string,
  fromLocationId: string,
  exceptTransferId: string,
): Promise<number> {
  const [row] = await conn
    .select({ total: sum(transferItems.quantityDispatched) })
    .from(transferItems)
    .innerJoin(transfers, eq(transfers.id, transferItems.transferId))
    .where(
      and(
        eq(transferItems.batchId, batchId),
        eq(transferItems.inPieces, true),
        eq(transfers.fromLocationId, fromLocationId),
        inArray(transfers.status, ["DRAFT"]),
        ne(transfers.id, exceptTransferId),
      ),
    );
  return Number(row?.total ?? 0);
}
