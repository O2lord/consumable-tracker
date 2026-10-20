import "server-only";
import { and, asc, desc, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { pharmacyImports } from "../../db/schema";
import type {
  PharmacyBalance,
  PharmacyBatchInfo,
  PharmacyGrnLine,
  PharmacyProvider,
  PharmacyTransferInfo,
} from "./provider";

// The CSV provider (architecture section 9): answers from the Pharmacy exports loaded into
// pharmacy_imports. Everything it returns is a snapshot, so each answer carries the time of the import
// it came from, and "not found" means "not in the files loaded", never "does not exist in Pharmacy".

const norm = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

export const csvPharmacyProvider: PharmacyProvider = {
  source: "csv",

  async listGrns(grnRef) {
    const where = grnRef
      ? and(eq(pharmacyImports.kind, "GRN_LINE"), sql`upper(${pharmacyImports.pharmacyRef}) = upper(${grnRef.trim()})`)
      : eq(pharmacyImports.kind, "GRN_LINE");
    const rows = await db()
      .select()
      .from(pharmacyImports)
      .where(where)
      .orderBy(desc(pharmacyImports.importedAt), asc(pharmacyImports.pharmacyRef), asc(pharmacyImports.itemLabel));
    return rows.map(
      (r): PharmacyGrnLine => ({
        grnRef: r.pharmacyRef ?? "",
        itemLabel: r.itemLabel ?? "",
        itemKey: r.itemKey ?? "",
        batchNo: r.batchNo ?? "",
        expiryDate: r.expiryDate,
        quantity: r.quantity,
        unitCost: r.unitCost,
        unit: r.unit,
        category: r.category,
        supplier: r.supplier,
        importedAt: r.importedAt,
      }),
    );
  },

  async getBatch(batchNo) {
    const key = norm(batchNo);
    if (!key) return null;
    const matchesBatch = sql`consumables.norm_text(${pharmacyImports.batchNo}) = ${key}`;

    // Stock on hand per location comes from the inventory exports.
    const inventory = await db()
      .select()
      .from(pharmacyImports)
      .where(and(eq(pharmacyImports.kind, "INVENTORY"), isNotNull(pharmacyImports.locationId), matchesBatch))
      .orderBy(desc(pharmacyImports.importedAt));

    // A batch that has only arrived on a GRN (not yet in any inventory export) is still known.
    const grn = inventory.length
      ? []
      : await db()
          .select()
          .from(pharmacyImports)
          .where(and(eq(pharmacyImports.kind, "GRN_LINE"), matchesBatch))
          .orderBy(desc(pharmacyImports.importedAt))
          .limit(1);

    const first = inventory[0] ?? grn[0];
    if (!first) return null;

    const perLocation = new Map<string, { locationId: string; quantity: number; importedAt: Date }>();
    for (const r of inventory) {
      if (!r.locationId) continue;
      const seen = perLocation.get(r.locationId);
      if (seen) {
        seen.quantity += r.quantity;
        if (r.importedAt > seen.importedAt) seen.importedAt = r.importedAt;
      } else {
        perLocation.set(r.locationId, { locationId: r.locationId, quantity: r.quantity, importedAt: r.importedAt });
      }
    }

    return {
      batchNo: first.batchNo ?? batchNo,
      itemLabel: first.itemLabel ?? "",
      expiryDate: first.expiryDate,
      unitCost: first.unitCost,
      balances: [...perLocation.values()],
    } satisfies PharmacyBatchInfo;
  },

  async getTransfer(ref) {
    const wanted = ref.trim();
    if (!wanted) return null;
    const [r] = await db()
      .select()
      .from(pharmacyImports)
      .where(and(eq(pharmacyImports.kind, "TRANSFER"), sql`upper(${pharmacyImports.pharmacyRef}) = upper(${wanted})`))
      .orderBy(desc(pharmacyImports.importedAt))
      .limit(1);
    if (!r) return null;
    return {
      ref: r.pharmacyRef,
      type: r.transferType,
      fromLabel: r.locationLabel,
      toLabel: r.destinationLabel,
      status: r.status,
      requestedBy: r.requestedBy,
      requestedAt: r.requestedAt,
      quantity: r.quantity,
      lines: r.lines,
    } satisfies PharmacyTransferInfo;
  },

  async getBalances(locationId) {
    const where = locationId
      ? and(eq(pharmacyImports.kind, "INVENTORY"), eq(pharmacyImports.locationId, locationId))
      : and(eq(pharmacyImports.kind, "INVENTORY"), isNotNull(pharmacyImports.locationId));
    const rows = await db()
      .select()
      .from(pharmacyImports)
      .where(where)
      .orderBy(asc(pharmacyImports.locationId), asc(pharmacyImports.itemLabel), asc(pharmacyImports.batchNo));
    const out: PharmacyBalance[] = [];
    for (const r of rows) {
      if (!r.locationId) continue;
      out.push({
        locationId: r.locationId,
        itemLabel: r.itemLabel ?? "",
        batchNo: r.batchNo ?? "",
        expiryDate: r.expiryDate,
        unitCost: r.unitCost,
        quantity: r.quantity,
        importedAt: r.importedAt,
      });
    }
    return out;
  },
};
