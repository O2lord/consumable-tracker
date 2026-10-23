"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requirePermission } from "@/server/auth/session";
import { issueBottle } from "@/server/services/issue.service";
import { bottlesInStock, standardItemsForTest, stockBottlesForIssue } from "@/server/services/extension.service";
import { AlreadyIssuedError, ValidationError } from "@/server/domain/errors";
import { toFormError } from "@/server/actions/form-result";
import { formDataToObject } from "@/lib/form";
import { withMrnPrefix } from "@/lib/reference-formats";
import type { FormState } from "@/components/forms/form-state";

const PATH = "/distribution/issue";

/** The bottles of an "issue all" run, as the form sends them: the selected bottle first. */
const bottlePlanSchema = z
  .array(
    z.object({
      container: z.string().trim().min(1).max(40),
      testCode: z.string().trim().min(1).max(40).optional(),
    }),
  )
  .min(1)
  .max(10);

type Raw = Record<string, unknown>;
type Issued = Awaited<ReturnType<typeof issueBottle>>;
type ItemLine = { itemTypeId: string; quantity: string };

const stockCheckSchema = z.object({
  bottles: bottlePlanSchema,
  locationId: z.string().trim().max(60).optional(),
});

/**
 * Whether each bottle of the pasted request has an in-date bottle in stock here, so the pop-up can hold "Issue all"
 * back (and offer to remove the one that is out) before anything is issued. Only looks. `ok: false` means the check
 * itself could not run, which never blocks anything: the issue still checks stock itself.
 */
export async function checkBottleStockAction(
  input: unknown,
): Promise<{ ok: true; available: Record<string, boolean> } | { ok: false }> {
  const session = await requirePermission("issue");
  const parsed = stockCheckSchema.safeParse(input);
  if (!parsed.success) return { ok: false };
  try {
    const found = await bottlesInStock(parsed.data.bottles, parsed.data.locationId || undefined, session);
    return { ok: true, available: Object.fromEntries(parsed.data.bottles.map((b, i) => [b.container, found[i]])) };
  } catch {
    return { ok: false };
  }
}

/** What one run of a test normally uses, as form lines. Nothing for a test that is not in the catalog or lists none. */
async function standardLines(testCode: string | undefined): Promise<ItemLine[]> {
  if (!testCode) return [];
  const { items } = await standardItemsForTest(testCode);
  return items.map((i) => ({ itemTypeId: i.itemTypeId, quantity: String(i.quantity) }));
}

/** "IXS181 LFT" per line (reference, then the test it is for). A line without a test code gets the test chosen on screen. */
function parseReferenceLines(type: string, text: unknown, defaultTestCode?: string) {
  return String(text ?? "")
    .split(/[\n;,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((line) => {
      if (type !== "INVESTIGATION") return { type, ref: line };
      const [ref, testCode] = line.split(/\s+/);
      return { type, ref, testCode: testCode || defaultTestCode || undefined };
    });
}

/**
 * Issues one bottle to the references on the form. `serials` is the scanned bottle, or (from stock) the in-date
 * candidates in order: when someone else takes one in the meantime the next is tried.
 */
async function issueOneBottle(
  raw: Raw,
  session: Awaited<ReturnType<typeof requirePermission>>,
  type: string,
  fromStock: boolean,
  serials: string[],
  testCode: string | undefined,
  items: ItemLine[],
): Promise<Issued> {
  for (const serial of serials) {
    try {
      return await issueBottle(
        {
          serial,
          references: parseReferenceLines(type, raw.references, testCode) as never,
          patientHospitalNo: raw.patientHospitalNo ? withMrnPrefix(String(raw.patientHospitalNo)) : undefined,
          patientType: raw.patientType as never,
          collectorType: raw.collectorType as never,
          collectorName: String(raw.collectorName ?? ""),
          locationId: raw.locationId as string | undefined,
          override: raw.useOverride ? { reason: String(raw.overrideReason ?? "") } : undefined,
          items: items as never,
        },
        session,
      );
    } catch (err) {
      // Someone else took this bottle between the lookup and now: try the next one from stock.
      if (fromStock && err instanceof AlreadyIssuedError) continue;
      throw err;
    }
  }
  throw new ValidationError("The bottles in stock were just issued by someone else. Try again");
}

const describeIssued = (r: Issued) => `${r.serial} (${r.itemName}) for ${r.references.map((x) => x.ref).join(", ")}`;

const itemsUsed = (r: Issued) =>
  r.consumables.map((l) => `${l.quantity}${l.inPieces ? " pieces of" : " x"} ${l.itemName}`).join(", ");

function issueNotes(results: Issued[]): string[] {
  const unverified = results.reduce((sum, r) => sum + r.unverified, 0);
  return [
    unverified > 0 ? `${unverified} payment(s) could not be verified and are flagged` : "",
    results.some((r) => r.overridden) ? "Supervisor override recorded" : "",
  ].filter(Boolean);
}

/**
 * Issue one bottle: one scan links it to every reference listed, and the per-patient items the person confirmed on
 * screen (edited, added or removed) leave the shelf with it, once, linked to the patient. The form sends the items
 * as paired itemTypeId / lineQuantity fields, in the same order. With "Issue from stock" no bottle is scanned: the
 * tracker takes one from stock at the work location, earliest expiry first, the way the browser extension does.
 *
 * "Issue all N bottles from stock" (issueAll) does that for every bottle the pasted request needs, one after the
 * other, each linked to the same references. It first checks that every bottle has stock here and issues nothing if
 * one has none. The items confirmed on screen go with the first bottle (the selected one); every other bottle gets
 * its test's standard items. If a bottle cannot be issued after all, the ones already issued stay issued and the
 * result lists them next to the error, so the pop-up can carry on with the rest.
 */
export async function issueUnitAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const session = await requirePermission("issue");
  const raw = formDataToObject(formData, ["useOverride"]);
  const type = String(raw.referenceType ?? "INVESTIGATION");
  const fromStock = raw.fromStock === "1";
  const issueAll = fromStock && raw.issueAll === "1";
  const ids = formData.getAll("itemTypeId").map(String);
  const quantities = formData.getAll("lineQuantity").map(String);
  // Items always come off the shelf first-expiry-first-out; no pack is named.
  const items = ids
    .map((itemTypeId, i) => ({ itemTypeId, quantity: quantities[i] }))
    .filter((line) => line.itemTypeId.trim() !== "");
  try {
    if (issueAll) return await issueAllBottles(raw, session, type, items);

    const serials = fromStock
      ? await stockBottlesForIssue(
          {
            testCode: raw.testCode ? String(raw.testCode) : undefined,
            container: raw.stockContainer ? String(raw.stockContainer) : undefined,
            locationId: raw.locationId as string | undefined,
          },
          session,
        )
      : [String(raw.serial ?? "")];
    const result = await issueOneBottle(raw, session, type, fromStock, serials, raw.testCode ? String(raw.testCode) : undefined, items);
    revalidatePath(PATH);
    const used = itemsUsed(result);
    const notes = issueNotes([result]);
    return {
      message:
        `Issued ${describeIssued(result)}.` +
        (used ? ` Items issued with it: ${used}.` : "") +
        (fromStock ? " The label is ready to print." : " Print the label from the list below.") +
        (notes.length ? ` ${notes.join(". ")}.` : ""),
      serial: result.serial,
    };
  } catch (err) {
    return toFormError(err);
  }
}

async function issueAllBottles(
  raw: Raw,
  session: Awaited<ReturnType<typeof requirePermission>>,
  type: string,
  items: ItemLine[],
): Promise<FormState> {
  let plan: z.infer<typeof bottlePlanSchema>;
  try {
    plan = bottlePlanSchema.parse(JSON.parse(String(raw.bottlePlan ?? "")));
  } catch {
    throw new ValidationError("Paste the request and choose the bottles first, so the right bottles are taken from stock");
  }
  const found = await bottlesInStock(plan, raw.locationId as string | undefined, session);
  const out = plan.filter((_, i) => !found[i]).map((b) => b.container);
  if (out.length > 0) {
    throw new ValidationError(
      `No ${out.join(" or ")} bottle is in stock at your location (expired bottles are left out). Nothing was issued. Remove ${out.length === 1 ? "it" : "them"} from the list, or scan ${out.length === 1 ? "it" : "them"} instead`,
    );
  }
  const issued: { container: string; result: Issued }[] = [];
  let failure: { container: string; error: unknown } | null = null;
  for (const [index, bottle] of plan.entries()) {
    try {
      const serials = await stockBottlesForIssue(
        { testCode: bottle.testCode, container: bottle.container, locationId: raw.locationId as string | undefined },
        session,
      );
      // The items confirmed on screen belong to the selected bottle, which is first in the plan. The others take their
      // test's standard items.
      const lines = index === 0 ? items : await standardLines(bottle.testCode);
      const result = await issueOneBottle(raw, session, type, true, serials, bottle.testCode, lines);
      issued.push({ container: bottle.container, result });
    } catch (err) {
      // Nothing issued yet: the normal error handling. Otherwise keep what was issued and report the rest.
      if (issued.length === 0) throw err;
      failure = { container: bottle.container, error: err };
      break;
    }
  }
  revalidatePath(PATH);

  const results = issued.map((i) => i.result);
  const itemsText = results
    .map((r) => ({ serial: r.serial, used: itemsUsed(r) }))
    .filter((x) => x.used)
    .map((x) => `${x.serial}: ${x.used}`)
    .join("; ");
  const notes = issueNotes(results);
  const summary =
    `Issued ${results.length === 1 ? "1 bottle" : `${results.length} bottles`}: ${results.map(describeIssued).join("; ")}.` +
    (itemsText ? ` Items issued: ${itemsText}.` : "") +
    (notes.length ? ` ${notes.join(". ")}.` : "");
  const base = {
    serial: results[0].serial,
    serials: results.map((r) => r.serial),
    containers: issued.map((i) => i.container),
  };
  if (failure) {
    const reason = toFormError(failure.error).error ?? "";
    return { ...base, message: summary, error: `${summary} Could not issue the ${failure.container} bottle: ${reason}` };
  }
  return { ...base, message: `${summary} The labels are ready to print.` };
}
