import { NextResponse } from "next/server";
import { apiFailure, guard } from "@/server/auth/api-guard";
import { listActiveItemTypes } from "@/server/services/catalog.service";
import { isPackUnit, perTestUnit } from "@/lib/pack-size";

// GET /api/ext/bulk-items -> the bulk (quantity-tracked) items that can be added to the "items used" list in the
// panel. Serialized items (bottles, tubes) are left out: they are scanned and issued on their own. So are bench
// supplies (cotton wool, gloves...): the lab records those under Used for test, not per patient.

export async function GET() {
  const auth = await guard("issue");
  if (auth.error) return auth.error;
  try {
    const items = await listActiveItemTypes();
    return NextResponse.json({
      items: items
        .filter((i) => i.trackingMode === "QUANTITY" && !i.benchSupply)
        .map((i) => ({
          itemTypeId: i.id,
          name: i.name,
          unitOfMeasure: perTestUnit(i.unitOfMeasure, i.packSize),
          packItem: isPackUnit(i.unitOfMeasure) && i.packSize > 1,
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    });
  } catch (err) {
    return apiFailure(err);
  }
}
