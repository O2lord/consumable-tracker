import "server-only";
import { eq, inArray } from "drizzle-orm";
import type { DbOrTx } from "../audit/events";
import { packs, transferItemPacks, transferItems } from "../db/schema";
import { generatePackCode } from "../../lib/serial";

// A pack is one physical pack or roll with its own barcode. The batch ledger stays the authority on stock; these rows
// only give each pack an identity and a "pieces remaining" figure. See 20261015000400_pack_labels.sql.

const PACK_CHUNK = 1000;

export interface PackRef {
  id: string;
  code: string;
}

/**
 * Makes one pack row per pack for a batch received in packs or rolls (or a batch of bottles received in packs), each
 * starting full. `piecesPerPack` is the item's pack size (1 for a roll or a pack with no size set). `cartonIdOf` says
 * which carton the pack at a given position (0-based) came in, or null for a pack received with no carton.
 * Returns the new packs in creation order.
 */
export async function createPacksForBatch(
  tx: DbOrTx,
  input: {
    batchId: string;
    itemTypeId: string;
    locationId: string;
    count: number;
    piecesPerPack: number;
    cartonIdOf?: (index: number) => string | null;
  },
): Promise<PackRef[]> {
  const piecesPerPack = Math.max(1, Math.trunc(input.piecesPerPack));
  const codeSet = new Set<string>();
  while (codeSet.size < input.count) codeSet.add(generatePackCode());
  const codes = [...codeSet];

  const made: PackRef[] = [];
  for (let i = 0; i < codes.length; i += PACK_CHUNK) {
    const slice = codes.slice(i, i + PACK_CHUNK);
    const rows = await tx
      .insert(packs)
      .values(
        slice.map((code, j) => ({
          code,
          batchId: input.batchId,
          itemTypeId: input.itemTypeId,
          locationId: input.locationId,
          piecesPerPack,
          piecesRemaining: piecesPerPack,
          cartonId: input.cartonIdOf?.(i + j) ?? null,
        })),
      )
      .returning({ id: packs.id, code: packs.code });
    const byCode = new Map(rows.map((r) => [r.code, r] as const));
    for (const code of slice) made.push(byCode.get(code)!);
  }
  return made;
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
