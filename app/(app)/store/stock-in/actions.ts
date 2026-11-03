"use server";

import { redirect } from "next/navigation";
import { requirePermission } from "@/server/auth/session";
import { stockIn } from "@/server/services/stock-in.service";
import { db } from "@/server/db/client";
import { listActiveItemTypes } from "@/server/services/catalog.service";
import { createDelivery } from "@/server/services/delivery.service";
import { toFormError } from "@/server/actions/form-result";
import { formDataToObject, issuesToMessage } from "@/lib/form";
import { RECEIVE_ENTRIES, type ReceiveEntry } from "@/lib/pack-size";
import { stockInInputSchema, type StockInInput } from "@/types/stock-in";
import type { FormState } from "@/components/forms/form-state";

/** What the form says a quantity was counted in. Anything else (or nothing) means the item's own unit. */
function entryOf(value: unknown): ReceiveEntry | undefined {
  return RECEIVE_ENTRIES.find((e) => e === value);
}

export async function stockInAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const session = await requirePermission("stock_in");

  const raw = formDataToObject(formData);
  // The service turns cartons or packs into the item's own unit and refuses what does not fit (no carton size, pieces
  // that are not whole packs, too many labels), so the same rules apply here and in a delivery.
  const parsed = stockInInputSchema.safeParse({ ...raw, quantity: Number(raw.quantity), entry: entryOf(raw.entryUnit) });
  if (!parsed.success) return { error: issuesToMessage(parsed.error) };
  const input = parsed.data;
  let batchCode: string;
  try {
    const result = await stockIn(input, session.userId);
    batchCode = result.batch.code;
  } catch (err) {
    return toFormError(err);
  }
  // redirect() works by throwing, so it must stay outside the try block.
  redirect(`/store/stock-in/${batchCode}`);
}

/**
 * Receives a delivery of one or more items. The delivery gets its own record and code (one supplier, one store, who
 * received it and when). Each item becomes a batch under it, with its own quantity, lot, expiry and label, all in one
 * transaction: if any line is rejected, nothing is received. The form sends one value per item, in the same order,
 * for itemTypeId, quantity, entryUnit, lotNo and expiryDate; the store, supplier and invoice number are shared.
 */
export async function stockInManyAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const session = await requirePermission("stock_in");

  const text = (key: string) => formData.getAll(key).map((v) => String(v));
  const locationId = String(formData.get("locationId") ?? "");
  const supplier = String(formData.get("supplier") ?? "").trim();
  const reference = String(formData.get("reference") ?? "").trim().slice(0, 100);
  const ids = text("itemTypeId");
  const quantities = text("quantity");
  const entryUnits = text("entryUnit");
  const lots = text("lotNo");
  const expiries = text("expiryDate");

  if (ids.length === 0) return { error: "Choose at least one item" };
  if (new Set(ids).size !== ids.length) return { error: "An item is listed twice. Add its quantities together instead" };

  const items = await listActiveItemTypes();
  const inputs: StockInInput[] = [];
  for (let i = 0; i < ids.length; i++) {
    const item = items.find((it) => it.id === ids[i]);
    if (!item) return { error: "One of the items is no longer available" };

    const parsed = stockInInputSchema.safeParse({
      itemTypeId: ids[i],
      locationId,
      quantity: Number(quantities[i]),
      lotNo: lots[i]?.trim() || undefined,
      expiryDate: expiries[i] || undefined,
      supplier: supplier || undefined,
      entry: entryOf(entryUnits[i]),
    });
    if (!parsed.success) return { error: `${item.name}: ${issuesToMessage(parsed.error)}` };
    inputs.push(parsed.data);
  }

  let deliveryCode: string;
  try {
    deliveryCode = await db().transaction(async (tx) => {
      const delivery = await createDelivery(
        { supplier: supplier || null, reference: reference || null, locationId: inputs[0].locationId, userId: session.userId },
        tx,
      );
      for (const input of inputs) {
        await stockIn(input, session.userId, tx, { source: "MANUAL", deliveryId: delivery.id });
      }
      return delivery.code;
    });
  } catch (err) {
    return toFormError(err);
  }
  // redirect() works by throwing, so it must stay outside the try block.
  // Every receipt is a delivery with a DV code, so it always lands on the delivery page, even for one item.
  redirect(`/store/stock-in/delivery/${deliveryCode}`);
}
