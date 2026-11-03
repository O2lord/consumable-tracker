import "server-only";
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { appendEvents, type DbOrTx, type NewEvent } from "../audit/events";
import { db } from "../db/client";
import { isUniqueViolation } from "../db/errors";
import { quantityLoose, quantityOnHand } from "../db/queries/quantity";
import { batches, conversionLines, conversionRecipes, conversions, events, itemTypes, locations, users } from "../db/schema";
import {
  inputMeasure,
  outputExpiryDate,
  planConversion,
  recipeItemsProblem,
  type ConversionItem,
  type InputMeasure,
} from "../domain/conversion-rules";
import { NotFoundError, ValidationError } from "../domain/errors";
import { resolveWorkLocation } from "../domain/issue-rules";
import type { Actor } from "../domain/types";
import { generateBatchCode, generateConversionCode, parseConversionCode } from "../../lib/serial";
import { pageInfo, type Paged } from "../../lib/pagination";
import {
  conversionInputSchema,
  recipeInputSchema,
  recipeUpdateSchema,
  voidConversionSchema,
  type ConversionInput,
  type RecipeInput,
  type RecipeUpdate,
  type VoidConversionInput,
} from "../../types/conversion";
import { allocateFromBatches, allocatePiecesFromBatches } from "./issue.service";

// Lab conversions: the lab turns stock it holds into another item (concentrated formalin into the 10% working
// solution) by a fixed recipe. The scientist enters only how much of the input to use; the output amount, its expiry
// and its code are worked out here, never typed. Callers check the `record_conversion` permission.
//
// One transaction does all of it, so a failure leaves nothing half done:
//   1. The input is taken off the shelf the same way Used for test takes it: earliest expiry first, expired batches
//      skipped, a sealed pack opened when loose pieces are needed (an OPENED event), then a CONVERTED_OUT event per
//      batch drawn. A shortfall refuses the whole conversion and writes nothing.
//   2. The output becomes a new batch of the output item, its lot being the conversion code, with one CONVERTED_IN
//      event. It is stored as loose units at that lab: no sealed pack, nothing to open.
//   3. conversions and conversion_lines link the two, so a dilute bottle can be traced to its concentrate batch.
//
// The output expires after the recipe's shelf life, but never later than the earliest expiry of the batches it was made
// from (see outputExpiryDate). A conversion can be voided while nothing from its output has moved (see
// voidConversion): the stock is put back by new reversing events, never by deleting.

const todayUtc = () => new Date().toISOString().slice(0, 10);

/** What the rules need about an item, plus its id and whether it is active. */
type ItemFacts = ConversionItem & { id: string; active: boolean };

export interface ConversionRecipeView {
  id: string;
  code: string;
  name: string;
  inputItemTypeId: string;
  inputItemName: string;
  outputItemTypeId: string;
  outputItemName: string;
  inputAmount: number;
  outputAmount: number;
  /** The word beside the amounts ("mL"). */
  measureLabel: string;
  shelfLifeDays: number | null;
  active: boolean;
  /** True when the input is counted in loose pieces (a pack item): its pack size is then `inputPackSize`. */
  inputInPieces: boolean;
  inputPackSize: number;
}

type LoadedRecipe = Omit<ConversionRecipeView, "inputInPieces" | "inputPackSize"> & { input: ItemFacts; output: ItemFacts };

async function loadRecipe(conn: DbOrTx, recipeId: string): Promise<LoadedRecipe> {
  const inItem = alias(itemTypes, "in_item");
  const outItem = alias(itemTypes, "out_item");
  const [row] = await conn
    .select({
      id: conversionRecipes.id,
      code: conversionRecipes.code,
      name: conversionRecipes.name,
      inputAmount: conversionRecipes.inputAmount,
      outputAmount: conversionRecipes.outputAmount,
      measureLabel: conversionRecipes.measureLabel,
      shelfLifeDays: conversionRecipes.shelfLifeDays,
      active: conversionRecipes.active,
      input: {
        id: inItem.id,
        name: inItem.name,
        trackingMode: inItem.trackingMode,
        unitOfMeasure: inItem.unitOfMeasure,
        packSize: inItem.packSize,
        testsPerUnit: inItem.testsPerUnit,
        active: inItem.active,
      },
      output: {
        id: outItem.id,
        name: outItem.name,
        trackingMode: outItem.trackingMode,
        unitOfMeasure: outItem.unitOfMeasure,
        packSize: outItem.packSize,
        testsPerUnit: outItem.testsPerUnit,
        active: outItem.active,
      },
    })
    .from(conversionRecipes)
    .innerJoin(inItem, eq(inItem.id, conversionRecipes.inputItemTypeId))
    .innerJoin(outItem, eq(outItem.id, conversionRecipes.outputItemTypeId))
    .where(eq(conversionRecipes.id, recipeId));
  if (!row) throw new NotFoundError("Conversion recipe");
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    inputItemTypeId: row.input.id,
    inputItemName: row.input.name,
    outputItemTypeId: row.output.id,
    outputItemName: row.output.name,
    inputAmount: row.inputAmount,
    outputAmount: row.outputAmount,
    measureLabel: row.measureLabel,
    shelfLifeDays: row.shelfLifeDays,
    active: row.active,
    input: row.input,
    output: row.output,
  };
}

/**
 * Read-only look at what the shelf can give: how much of the input is available here (expired batches left out) and the
 * expiry of each batch the request would draw from. It walks the batches in the same order the allocators do (earliest
 * expiry first), so the preview and the real conversion agree. The real conversion still locks and re-checks.
 */
async function peekInput(
  conn: DbOrTx,
  itemTypeId: string,
  measure: InputMeasure,
  locationId: string,
  quantity: number,
): Promise<{ available: number; expiries: (string | null)[] }> {
  const candidates = await conn
    .select({ id: batches.id, expiryDate: batches.expiryDate })
    .from(batches)
    .where(and(eq(batches.itemTypeId, itemTypeId), or(isNull(batches.expiryDate), gte(batches.expiryDate, todayUtc()))))
    .orderBy(asc(batches.expiryDate), asc(batches.createdAt), asc(batches.id));

  let available = 0;
  let remaining = quantity;
  const expiries: (string | null)[] = [];
  for (const candidate of candidates) {
    const sealed = Math.max(await quantityOnHand(conn, candidate.id, locationId), 0);
    const loose = measure.kind === "PIECES" ? Math.max(await quantityLoose(conn, candidate.id, locationId), 0) : 0;
    const here = measure.kind === "PIECES" ? sealed * measure.packSize + loose : sealed;
    if (here <= 0) continue;
    available += here;
    if (remaining > 0) {
      expiries.push(candidate.expiryDate);
      remaining -= Math.min(here, remaining);
    }
  }
  return { available, expiries };
}

export interface ConversionPreview {
  recipeId: string;
  recipeName: string;
  inputItemName: string;
  outputItemName: string;
  inputQuantity: number;
  outputQuantity: number;
  measureLabel: string;
  /** The day the output expires. Null when the recipe has no shelf life. */
  expiryDate: string | null;
  /** The code the output will carry (its lot). Send it back with the confirmation so the label shown is the one recorded. */
  code: string;
  /** How much of the input the shelf holds here now, in the recipe's measure. */
  available: number;
}

interface Prepared {
  recipe: LoadedRecipe;
  locationId: string;
  measure: InputMeasure;
  inputQuantity: number;
  outputQuantity: number;
  available: number;
  expiries: (string | null)[];
  note: string | null;
  suppliedCode: string | null;
}

/** Everything both the preview and the real conversion decide: where, which recipe, how much, and whether the shelf can give it. */
async function prepare(conn: DbOrTx, rawInput: ConversionInput, actor: Actor): Promise<Prepared> {
  const parsed = conversionInputSchema.safeParse(rawInput);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  const input = parsed.data;

  const locationId = resolveWorkLocation(actor, input.locationId);
  const [location] = await conn.select({ id: locations.id, active: locations.active }).from(locations).where(eq(locations.id, locationId));
  if (!location || !location.active) throw new NotFoundError("Location");

  const recipe = await loadRecipe(conn, input.recipeId);
  if (!recipe.active) throw new ValidationError(`${recipe.name} is no longer in use. Ask an admin to turn it back on`);
  if (!recipe.output.active) throw new ValidationError(`${recipe.output.name} is no longer in use, so it cannot be made`);
  // Checked again here, not only when the recipe was saved: an item may have been edited since.
  const problem = recipeItemsProblem(recipe.input, recipe.output);
  if (problem) throw new ValidationError(problem);

  const measure = inputMeasure(recipe.input);
  const plan = planConversion(recipe, input.inputQuantity, recipe.measureLabel);
  if ("error" in plan) throw new ValidationError(plan.error);

  const { available, expiries } = await peekInput(conn, recipe.input.id, measure, locationId, plan.inputQuantity);
  if (available < plan.inputQuantity) {
    throw new ValidationError(
      `Only ${available.toLocaleString("en-GB")} ${recipe.measureLabel} of ${recipe.input.name} in stock here (expired batches are left out), but ${plan.inputQuantity.toLocaleString("en-GB")} ${recipe.measureLabel} are needed`,
    );
  }

  return {
    recipe,
    locationId,
    measure,
    inputQuantity: plan.inputQuantity,
    outputQuantity: plan.outputQuantity,
    available,
    expiries,
    note: input.note?.trim() || null,
    suppliedCode: input.code?.trim() || null,
  };
}

/**
 * What a conversion would do, before anything is written: the amount made, its expiry and the code it will carry.
 * Refuses for the same reasons a real conversion does (not a whole amount, not enough stock), so the screen can show
 * the problem as the scientist types.
 */
export async function previewConversion(rawInput: ConversionInput, actor: Actor, conn: DbOrTx = db()): Promise<ConversionPreview> {
  const p = await prepare(conn, rawInput, actor);
  return {
    recipeId: p.recipe.id,
    recipeName: p.recipe.name,
    inputItemName: p.recipe.input.name,
    outputItemName: p.recipe.output.name,
    inputQuantity: p.inputQuantity,
    outputQuantity: p.outputQuantity,
    measureLabel: p.recipe.measureLabel,
    expiryDate: outputExpiryDate({
      convertedOn: todayUtc(),
      shelfLifeDays: p.recipe.shelfLifeDays,
      inputExpiries: p.expiries,
    }),
    code: generateConversionCode(),
    available: p.available,
  };
}

export interface ConversionResult {
  id: string;
  code: string;
  recipeName: string;
  inputItemName: string;
  inputQuantity: number;
  outputItemName: string;
  outputQuantity: number;
  measureLabel: string;
  expiryDate: string | null;
  /** The batch the output was stored as (BT...), for stock screens and labels. */
  outputBatchCode: string;
  /** The batches the input was drawn from. */
  inputBatchCodes: string[];
}

/**
 * Does the conversion. The whole thing is one transaction: if the shelf is short, or anything else fails, nothing is
 * written. The amount made and the expiry are recomputed here from the recipe and the batches actually drawn, so what
 * the preview showed is never trusted.
 */
export async function recordConversion(rawInput: ConversionInput, actor: Actor, conn: DbOrTx = db()): Promise<ConversionResult> {
  try {
    return await conn.transaction(async (tx) => {
      const p = await prepare(tx, rawInput, actor);
      const { recipe, locationId, measure } = p;

      let code: string;
      if (p.suppliedCode) {
        const parsedCode = parseConversionCode(p.suppliedCode);
        if (!parsedCode) throw new ValidationError(`${p.suppliedCode} is not a valid conversion code. Reload the page and try again`);
        code = parsedCode;
      } else {
        code = generateConversionCode();
      }

      // The authoritative take: batches are locked and re-checked here, earliest expiry first.
      const inPieces = measure.kind === "PIECES";
      const taken = inPieces
        ? await allocatePiecesFromBatches(tx, recipe.input.id, recipe.input.name, locationId, p.inputQuantity, measure.packSize)
        : (await allocateFromBatches(tx, recipe.input.id, recipe.input.name, locationId, p.inputQuantity)).map((t) => ({
            ...t,
            opened: 0,
          }));

      const drawn = await tx
        .select({ id: batches.id, expiryDate: batches.expiryDate })
        .from(batches)
        .where(inArray(batches.id, [...new Set(taken.map((t) => t.batchId))]));
      const expiryDate = outputExpiryDate({
        convertedOn: todayUtc(),
        shelfLifeDays: recipe.shelfLifeDays,
        inputExpiries: drawn.map((d) => d.expiryDate),
      });

      const [conversion] = await tx
        .insert(conversions)
        .values({ code, recipeId: recipe.id, locationId, convertedBy: actor.userId, note: p.note })
        .returning({ id: conversions.id });

      const [outBatch] = await tx
        .insert(batches)
        .values({
          code: generateBatchCode(),
          itemTypeId: recipe.output.id,
          // The conversion code is the lot, so the bottle's label and the conversion are the same code.
          lotNo: code,
          expiryDate,
          quantity: p.outputQuantity,
          source: "MANUAL",
          receivedBy: actor.userId,
        })
        .returning({ id: batches.id, code: batches.code });

      const now = new Date();
      const payload = { source: "CONVERSION", conversionCode: code, recipeCode: recipe.code };
      const rows: NewEvent[] = [];
      const inputLineRows: { batchId: string; quantity: number; eventId: string }[] = [];
      for (const part of taken) {
        if (part.opened > 0) {
          // Opening a pack takes it off the sealed balance and adds its pieces to the loose ones, as Used for test does.
          rows.push({
            id: randomUUID(),
            unitId: null,
            batchId: part.batchId,
            quantity: part.opened,
            pieces: part.opened * (inPieces ? measure.packSize : 1),
            type: "OPENED",
            locationId,
            userId: actor.userId,
            occurredAt: now,
            payload: { reason: "OPENED_FOR_PIECES", source: "CONVERSION", conversionCode: code },
          });
        }
        const eventId = randomUUID();
        rows.push({
          id: eventId,
          unitId: null,
          batchId: part.batchId,
          // Pieces move no whole packs: the quantity is 0 and `pieces` carries the amount.
          quantity: inPieces ? 0 : part.quantity,
          ...(inPieces ? { pieces: part.quantity } : {}),
          type: "CONVERTED_OUT",
          locationId,
          userId: actor.userId,
          occurredAt: now,
          payload,
        });
        inputLineRows.push({ batchId: part.batchId, quantity: part.quantity, eventId });
      }

      const inEventId = randomUUID();
      rows.push({
        id: inEventId,
        unitId: null,
        batchId: outBatch.id,
        // The output is counted in its own unit (pack size 1), so it is whole units, never pieces.
        quantity: p.outputQuantity,
        type: "CONVERTED_IN",
        locationId,
        userId: actor.userId,
        occurredAt: now,
        payload,
      });
      await appendEvents(tx, rows);

      await tx.insert(conversionLines).values([
        ...inputLineRows.map((l) => ({
          conversionId: conversion.id,
          direction: "INPUT" as const,
          itemTypeId: recipe.input.id,
          batchId: l.batchId,
          quantity: l.quantity,
          inPieces,
          eventId: l.eventId,
        })),
        {
          conversionId: conversion.id,
          direction: "OUTPUT" as const,
          itemTypeId: recipe.output.id,
          batchId: outBatch.id,
          quantity: p.outputQuantity,
          inPieces: false,
          eventId: inEventId,
        },
      ]);

      return {
        id: conversion.id,
        code,
        recipeName: recipe.name,
        inputItemName: recipe.input.name,
        inputQuantity: p.inputQuantity,
        outputItemName: recipe.output.name,
        outputQuantity: p.outputQuantity,
        measureLabel: recipe.measureLabel,
        expiryDate,
        outputBatchCode: outBatch.code,
        inputBatchCodes: [...new Set(taken.map((t) => t.code))],
      };
    });
  } catch (err) {
    // The only unique column a conversion can collide on is its code (a code sent back after it was already used).
    if (isUniqueViolation(err)) {
      throw new ValidationError("That conversion was already recorded. Reload the page to see it");
    }
    throw err;
  }
}

// --- void ---------------------------------------------------------------------------------------------------------

export interface VoidConversionResult {
  code: string;
  inputItemName: string;
  /** What went back on the shelf, in the recipe's measure, summed over the batches it was drawn from. */
  inputQuantity: number;
  outputItemName: string;
  /** What came off the shelf. */
  outputQuantity: number;
  measureLabel: string;
}

/**
 * Voids a conversion made by mistake. Callers check the `void` permission.
 *
 * The stock is put back with new events, never by deleting or editing: each input line gets a CONVERTED_OUT_VOIDED event
 * (the input goes back on the shelf, whole units or loose pieces as it left) and the output gets a CONVERTED_IN_VOIDED
 * event (it comes off the shelf). A pack that was opened for the conversion stays open: its millilitres return to the
 * loose balance they were taken from.
 *
 * Allowed only while nothing from the output batch has moved: the batch's only event must be the CONVERTED_IN that made
 * it. Once any of the dilute has been used, sent, counted or adjusted, the conversion can no longer be undone, because
 * the people using it would be left with stock that vanishes. The output batch is locked first, so a use recorded at the
 * same moment either lands before the check (and refuses the void) or waits until after it (and finds no stock).
 * One transaction: a refusal writes nothing.
 */
export async function voidConversion(rawInput: VoidConversionInput, actor: Actor, conn: DbOrTx = db()): Promise<VoidConversionResult> {
  const parsed = voidConversionSchema.safeParse(rawInput);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  const input = parsed.data;

  return conn.transaction(async (tx) => {
    const [conversion] = await tx.select().from(conversions).where(eq(conversions.id, input.conversionId)).for("update");
    if (!conversion) throw new NotFoundError("Conversion");
    if (conversion.voidedAt) throw new ValidationError(`${conversion.code} has already been voided`);
    // The conversion is voided at the place it was made, by someone working there.
    const locationId = resolveWorkLocation(actor, input.locationId);
    if (locationId !== conversion.locationId) {
      throw new ValidationError(`${conversion.code} was made at another location. Switch to that location to void it`);
    }

    const lines = await tx.select().from(conversionLines).where(eq(conversionLines.conversionId, conversion.id));
    const output = lines.find((l) => l.direction === "OUTPUT");
    const inputs = lines.filter((l) => l.direction === "INPUT");
    if (!output || inputs.length === 0) throw new ValidationError(`${conversion.code} is incomplete and cannot be voided`);

    // Lock the output batch before reading its history.
    await tx.select({ id: batches.id }).from(batches).where(eq(batches.id, output.batchId)).for("update");
    const [{ others }] = await tx
      .select({ others: sql<number>`count(*)::int` })
      .from(events)
      .where(and(eq(events.batchId, output.batchId), ne(events.id, output.eventId)));
    const onHand = await quantityOnHand(tx, output.batchId, conversion.locationId);

    const [outItem] = await tx.select({ name: itemTypes.name }).from(itemTypes).where(eq(itemTypes.id, output.itemTypeId));
    const [inItem] = await tx.select({ name: itemTypes.name }).from(itemTypes).where(eq(itemTypes.id, inputs[0].itemTypeId));
    const [recipe] = await tx
      .select({ measureLabel: conversionRecipes.measureLabel })
      .from(conversionRecipes)
      .where(eq(conversionRecipes.id, conversion.recipeId));

    if (others > 0 || onHand !== output.quantity) {
      throw new ValidationError(
        `Some of the ${outItem.name} made by ${conversion.code} has already been used, moved or counted, so it can no longer be voided`,
      );
    }

    const now = new Date();
    const reason = input.reason;
    const rows: NewEvent[] = [];
    const reversal = new Map<string, string>(); // conversion line id -> its reversing event id
    for (const line of inputs) {
      const id = randomUUID();
      reversal.set(line.id, id);
      rows.push({
        id,
        unitId: null,
        batchId: line.batchId,
        // Mirrors the original: loose pieces move no whole packs (quantity 0, pieces carries the amount).
        quantity: line.inPieces ? 0 : line.quantity,
        ...(line.inPieces ? { pieces: line.quantity } : {}),
        type: "CONVERTED_OUT_VOIDED",
        locationId: conversion.locationId,
        userId: actor.userId,
        occurredAt: now,
        payload: { source: "CONVERSION_VOID", conversionCode: conversion.code, reverses: line.eventId, reason },
      });
    }
    const outId = randomUUID();
    reversal.set(output.id, outId);
    rows.push({
      id: outId,
      unitId: null,
      batchId: output.batchId,
      quantity: output.quantity,
      type: "CONVERTED_IN_VOIDED",
      locationId: conversion.locationId,
      userId: actor.userId,
      occurredAt: now,
      payload: { source: "CONVERSION_VOID", conversionCode: conversion.code, reverses: output.eventId, reason },
    });
    await appendEvents(tx, rows);

    for (const line of lines) {
      await tx.update(conversionLines).set({ voidEventId: reversal.get(line.id) }).where(eq(conversionLines.id, line.id));
    }
    await tx
      .update(conversions)
      .set({ voidedAt: now, voidedBy: actor.userId, voidReason: reason })
      .where(eq(conversions.id, conversion.id));

    return {
      code: conversion.code,
      inputItemName: inItem.name,
      inputQuantity: inputs.reduce((n, l) => n + l.quantity, 0),
      outputItemName: outItem.name,
      outputQuantity: output.quantity,
      measureLabel: recipe.measureLabel,
    };
  });
}

// --- recipes (Admin > Conversions) -------------------------------------------------------------------------------
// Callers check the `manage_conversions` permission.

/** A recipe as the admin screen shows it, with how many conversions have used it. */
export interface AdminRecipe {
  id: string;
  code: string;
  name: string;
  inputItemTypeId: string;
  inputItemName: string;
  outputItemTypeId: string;
  outputItemName: string;
  inputAmount: number;
  outputAmount: number;
  measureLabel: string;
  shelfLifeDays: number | null;
  active: boolean;
  /** Once a recipe has been used, its items and ratio are locked so past conversions keep their meaning. */
  conversionCount: number;
}

/** Every recipe, active or not, by name. */
export async function listRecipes(conn: DbOrTx = db()): Promise<AdminRecipe[]> {
  const inItem = alias(itemTypes, "in_item");
  const outItem = alias(itemTypes, "out_item");
  return conn
    .select({
      id: conversionRecipes.id,
      code: conversionRecipes.code,
      name: conversionRecipes.name,
      inputItemTypeId: conversionRecipes.inputItemTypeId,
      inputItemName: inItem.name,
      outputItemTypeId: conversionRecipes.outputItemTypeId,
      outputItemName: outItem.name,
      inputAmount: conversionRecipes.inputAmount,
      outputAmount: conversionRecipes.outputAmount,
      measureLabel: conversionRecipes.measureLabel,
      shelfLifeDays: conversionRecipes.shelfLifeDays,
      active: conversionRecipes.active,
      conversionCount: sql<number>`(select count(*)::int from consumables.conversions c where c.recipe_id = ${conversionRecipes.id})`,
    })
    .from(conversionRecipes)
    .innerJoin(inItem, eq(inItem.id, conversionRecipes.inputItemTypeId))
    .innerJoin(outItem, eq(outItem.id, conversionRecipes.outputItemTypeId))
    .orderBy(asc(conversionRecipes.name));
}

/** Loads the two items of a recipe and refuses a pair that cannot make one (see recipeItemsProblem). */
async function assertRecipeItems(conn: DbOrTx, inputId: string, outputId: string): Promise<void> {
  if (inputId === outputId) throw new ValidationError("The item that is made must be different from the item that is taken");
  const rows = await conn
    .select({
      id: itemTypes.id,
      name: itemTypes.name,
      trackingMode: itemTypes.trackingMode,
      unitOfMeasure: itemTypes.unitOfMeasure,
      packSize: itemTypes.packSize,
      testsPerUnit: itemTypes.testsPerUnit,
      active: itemTypes.active,
    })
    .from(itemTypes)
    .where(inArray(itemTypes.id, [inputId, outputId]));
  const input = rows.find((r) => r.id === inputId);
  const output = rows.find((r) => r.id === outputId);
  if (!input || !output) throw new NotFoundError("Item type");
  const inactive = [input, output].find((r) => !r.active);
  if (inactive) throw new ValidationError(`${inactive.name} is not in use. Choose an active item`);
  const problem = recipeItemsProblem(input, output);
  if (problem) throw new ValidationError(problem);
}

export async function createRecipe(rawInput: RecipeInput, conn: DbOrTx = db()) {
  const parsed = recipeInputSchema.safeParse(rawInput);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  const input = parsed.data;
  await assertRecipeItems(conn, input.inputItemTypeId, input.outputItemTypeId);
  try {
    const [row] = await conn
      .insert(conversionRecipes)
      .values({
        code: input.code,
        name: input.name,
        inputItemTypeId: input.inputItemTypeId,
        outputItemTypeId: input.outputItemTypeId,
        inputAmount: input.inputAmount,
        outputAmount: input.outputAmount,
        measureLabel: input.measureLabel,
        shelfLifeDays: input.shelfLifeDays ?? null,
      })
      .returning();
    return row;
  } catch (err) {
    if (isUniqueViolation(err)) throw new ValidationError(`Recipe ${input.code} already exists`);
    throw err;
  }
}

/**
 * Edits a recipe. The name, the unit label and the shelf life can always change (a new shelf life applies to later
 * conversions only). The items and the ratio can change only while no conversion has used the recipe: after that,
 * turn it off and make a new one.
 */
export async function updateRecipe(rawInput: RecipeUpdate, conn: DbOrTx = db()) {
  const parsed = recipeUpdateSchema.safeParse(rawInput);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  const input = parsed.data;

  const [current] = await conn.select().from(conversionRecipes).where(eq(conversionRecipes.id, input.id));
  if (!current) throw new NotFoundError("Conversion recipe");

  const structureChanged =
    current.inputItemTypeId !== input.inputItemTypeId ||
    current.outputItemTypeId !== input.outputItemTypeId ||
    current.inputAmount !== input.inputAmount ||
    current.outputAmount !== input.outputAmount;
  if (structureChanged) {
    const [{ used }] = await conn
      .select({ used: sql<number>`count(*)::int` })
      .from(conversions)
      .where(eq(conversions.recipeId, input.id));
    if (used > 0) {
      throw new ValidationError(
        `${current.name} has been used for ${used} ${used === 1 ? "conversion" : "conversions"}, so its items and ratio cannot change. Turn it off and add a new recipe instead`,
      );
    }
    await assertRecipeItems(conn, input.inputItemTypeId, input.outputItemTypeId);
  }

  await conn
    .update(conversionRecipes)
    .set({
      name: input.name,
      inputItemTypeId: input.inputItemTypeId,
      outputItemTypeId: input.outputItemTypeId,
      inputAmount: input.inputAmount,
      outputAmount: input.outputAmount,
      measureLabel: input.measureLabel,
      shelfLifeDays: input.shelfLifeDays ?? null,
    })
    .where(eq(conversionRecipes.id, input.id));
}

/** Turns a recipe on or off. Turning one on checks again that its items can still make it. */
export async function setRecipeActive(id: string, active: boolean, conn: DbOrTx = db()) {
  const [current] = await conn.select().from(conversionRecipes).where(eq(conversionRecipes.id, id));
  if (!current) throw new NotFoundError("Conversion recipe");
  if (active && !current.active) await assertRecipeItems(conn, current.inputItemTypeId, current.outputItemTypeId);
  await conn.update(conversionRecipes).set({ active }).where(eq(conversionRecipes.id, id));
}

/** The recipes people can pick at the lab, with how each input is counted. Active ones only, by name. */
export async function listActiveRecipes(conn: DbOrTx = db()): Promise<ConversionRecipeView[]> {
  const inItem = alias(itemTypes, "in_item");
  const outItem = alias(itemTypes, "out_item");
  const rows = await conn
    .select({
      id: conversionRecipes.id,
      code: conversionRecipes.code,
      name: conversionRecipes.name,
      inputItemTypeId: conversionRecipes.inputItemTypeId,
      inputItemName: inItem.name,
      outputItemTypeId: conversionRecipes.outputItemTypeId,
      outputItemName: outItem.name,
      inputAmount: conversionRecipes.inputAmount,
      outputAmount: conversionRecipes.outputAmount,
      measureLabel: conversionRecipes.measureLabel,
      shelfLifeDays: conversionRecipes.shelfLifeDays,
      active: conversionRecipes.active,
      inputUnit: inItem.unitOfMeasure,
      inputPackSize: inItem.packSize,
    })
    .from(conversionRecipes)
    .innerJoin(inItem, eq(inItem.id, conversionRecipes.inputItemTypeId))
    .innerJoin(outItem, eq(outItem.id, conversionRecipes.outputItemTypeId))
    .where(eq(conversionRecipes.active, true))
    .orderBy(asc(conversionRecipes.name));
  return rows.map(({ inputUnit, ...r }) => {
    const measure = inputMeasure({ unitOfMeasure: inputUnit, packSize: r.inputPackSize });
    return { ...r, inputInPieces: measure.kind === "PIECES", inputPackSize: r.inputPackSize };
  });
}

/**
 * What is on the shelf now for the input of each active recipe, in the measure the recipe counts it in:
 * `{ [itemTypeId]: { [locationId]: available } }`. Expired batches are left out, and a pack item is counted in loose
 * pieces (sealed packs times pack size plus the loose pieces of opened packs). Read a missing entry as zero.
 */
export async function listConversionAvailability(conn: DbOrTx = db()): Promise<Record<string, Record<string, number>>> {
  const [items, rows] = await Promise.all([
    conn
      .select({ id: itemTypes.id, unitOfMeasure: itemTypes.unitOfMeasure, packSize: itemTypes.packSize })
      .from(itemTypes)
      .innerJoin(conversionRecipes, and(eq(conversionRecipes.inputItemTypeId, itemTypes.id), eq(conversionRecipes.active, true))),
    conn.execute<{ item_type_id: string; location_id: string; sealed: string | number; loose: string | number }>(sql`
      select b.item_type_id, q.location_id, sum(q.on_hand) as sealed, coalesce(sum(l.loose), 0) as loose
      from consumables.v_quantity_balance q
      join consumables.batches b on b.id = q.batch_id
      left join consumables.v_loose_pieces l on l.batch_id = q.batch_id and l.location_id = q.location_id
      where b.item_type_id in (select input_item_type_id from consumables.conversion_recipes where active)
        and (b.expiry_date is null or b.expiry_date >= ${todayUtc()}::date)
      group by b.item_type_id, q.location_id
    `),
  ]);
  const measureOf = new Map(items.map((i) => [i.id, inputMeasure(i)] as const));

  const result: Record<string, Record<string, number>> = {};
  for (const r of rows) {
    const measure = measureOf.get(r.item_type_id);
    if (!measure) continue;
    const sealed = Math.max(Number(r.sealed), 0);
    const available = measure.kind === "PIECES" ? sealed * measure.packSize + Math.max(Number(r.loose), 0) : sealed;
    if (available <= 0) continue;
    (result[r.item_type_id] ??= {})[r.location_id] = available;
  }
  return result;
}

/** One line on the Conversion page: one conversion, with what went in and what came out. */
export interface RecentConversion {
  id: string;
  code: string;
  recipeName: string;
  inputItemName: string;
  /** In the recipe's measure, summed over the batches drawn. */
  inputQuantity: number;
  outputItemName: string;
  outputQuantity: number;
  measureLabel: string;
  outputBatchCode: string;
  expiryDate: string | null;
  note: string | null;
  locationName: string;
  convertedByName: string;
  convertedAt: Date;
  /** Set when the conversion was voided: when, and the reason given. The row stays in the list. */
  voidedAt: Date | null;
  voidReason: string | null;
}

/** One page (20 entries) of the Conversion list, newest first, plus the total. */
export async function listConversionsPage(locationId: string | undefined, page: number, conn: DbOrTx = db()): Promise<Paged<RecentConversion>> {
  const [{ total }] = await conn
    .select({ total: sql<number>`count(*)::int` })
    .from(conversions)
    .where(locationId ? eq(conversions.locationId, locationId) : undefined);
  const info = pageInfo(page, total);
  const rows = await listRecentConversions(locationId, info.pageSize, conn, info.offset);
  return { ...info, rows };
}

/** The latest conversions, newest first. Pass a location to see only that one; leave it out to see every location. */
export async function listRecentConversions(
  locationId?: string,
  limit = 20,
  conn: DbOrTx = db(),
  offset = 0,
): Promise<RecentConversion[]> {
  const inItem = alias(itemTypes, "in_item");
  const outItem = alias(itemTypes, "out_item");
  const rows = await conn
    .select({
      id: conversions.id,
      code: conversions.code,
      recipeName: conversionRecipes.name,
      inputItemName: inItem.name,
      outputItemName: outItem.name,
      measureLabel: conversionRecipes.measureLabel,
      inputQuantity: sql<number>`(
        select coalesce(sum(cl.quantity), 0)::int
        from consumables.conversion_lines cl
        where cl.conversion_id = ${conversions.id} and cl.direction = 'INPUT'
      )`,
      outputQuantity: conversionLines.quantity,
      outputBatchCode: batches.code,
      expiryDate: batches.expiryDate,
      note: conversions.note,
      locationName: locations.name,
      convertedByName: users.name,
      convertedAt: conversions.convertedAt,
      voidedAt: conversions.voidedAt,
      voidReason: conversions.voidReason,
    })
    .from(conversions)
    .innerJoin(conversionRecipes, eq(conversionRecipes.id, conversions.recipeId))
    .innerJoin(inItem, eq(inItem.id, conversionRecipes.inputItemTypeId))
    .innerJoin(outItem, eq(outItem.id, conversionRecipes.outputItemTypeId))
    .innerJoin(conversionLines, and(eq(conversionLines.conversionId, conversions.id), eq(conversionLines.direction, "OUTPUT")))
    .innerJoin(batches, eq(batches.id, conversionLines.batchId))
    .innerJoin(locations, eq(locations.id, conversions.locationId))
    .innerJoin(users, eq(users.id, conversions.convertedBy))
    .where(locationId ? eq(conversions.locationId, locationId) : undefined)
    .orderBy(desc(conversions.convertedAt), desc(conversions.id))
    .limit(limit)
    .offset(offset);
  return rows;
}
