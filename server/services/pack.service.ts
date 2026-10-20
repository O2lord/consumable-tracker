import "server-only";
import { eq, inArray } from "drizzle-orm";
import type { DbOrTx } from "../audit/events";
import { packs, transferItemPacks, transferItems } from "../db/schema";
import { generatePackCode } from "../../lib/serial";

// A pack is one physical pack or roll with its own barcode. The batch ledger stays the authority on stock; these rows
// only give each pack an identity and a "pieces remaining" figure. See 20261015000400_pack_labels.sql.

const PACK_CHUNK = 1000;

/**
 * Makes one pack row per pack for a QUANTITY batch received in packs or rolls, each starting full.
 * `piecesPerPack` is the item's pack size (1 for a roll or a pack with no size set). Returns the new codes in order.
 */
export async function createPacksForBatch(
  tx: DbOrTx,
  input: { batchId: string; itemTypeId: string; locationId: string; count: number; piecesPerPack: number },
): Promise<string[]> {
  const piecesPerPack = Math.max(1, Math.trunc(input.piecesPerPack));
  const codeSet = new Set<string>();
  while (codeSet.size < input.count) codeSet.add(generatePackCode());
  const codes = [...codeSet];

  for (let i = 0; i < codes.length; i += PACK_CHUNK) {
    await tx.insert(packs).values(
      codes.slice(i, i + PACK_CHUNK).map((code) => ({
        code,
        batchId: input.batchId,
        itemTypeId: input.itemTypeId,
        locationId: input.locationId,
        piecesPerPack,
        piecesRemaining: piecesPerPack,
      })),
    );
  }
  return codes;
}

/**
 * Frees every scanned pack on a transfer so it can go on another one (the draft was cancelled, or the receipt closed).
 * Mirrors what `transfer_items.open = false` does for bottles.
 */
export async function closePackLinks(tx: DbOrTx, transferId: string): Promise<void> {
  await tx
    .update(transferItemPacks)
    .set({ open: false })
    .where(
      inArray(
        transferItemPacks.transferItemId,
        tx.select({ id: transferItems.id }).from(transferItems).where(eq(transferItems.transferId, transferId)),
      ),
    );
}

/** Pack codes of one batch, in code order. Empty for batches received before pack labels existed. */
export async function listPackCodes(conn: DbOrTx, batchId: string): Promise<string[]> {
  const rows = await conn.select({ code: packs.code }).from(packs).where(eq(packs.batchId, batchId)).orderBy(packs.code);
  return rows.map((r) => r.code);
}
