import { z } from "zod";
import { CONVERSION_AMOUNT_MAX, CONVERSION_SHELF_LIFE_MAX_DAYS } from "../server/domain/types";

// Validation for lab conversions. Shared by the server actions and conversion.service.ts.

/**
 * One conversion: a recipe and how much of its input to take, counted in the recipe's measure (mL for formalin).
 * What it makes, its expiry and its code are worked out by the server, never typed. `code` is the code the screen
 * showed in the preview, sent back so the label the scientist saw is the one that is recorded.
 */
export const conversionInputSchema = z.object({
  recipeId: z.uuid(),
  inputQuantity: z.coerce
    .number()
    .int("Enter a whole number")
    .min(1, "Enter a whole number, at least 1")
    .max(CONVERSION_AMOUNT_MAX, "That quantity is too large"),
  code: z.string().trim().max(40).optional(),
  note: z.string().trim().max(200, "Keep the note under 200 characters").optional(),
  locationId: z.uuid().optional(),
});
export type ConversionInput = z.input<typeof conversionInputSchema>;

/** Voiding a conversion: which one, and why. The reason is free text and required, so the history says what went wrong. */
export const voidConversionSchema = z.object({
  conversionId: z.uuid(),
  reason: z.string().trim().min(3, "Say why it is being voided").max(200, "Keep the reason under 200 characters"),
  locationId: z.uuid().optional(),
});
export type VoidConversionInput = z.input<typeof voidConversionSchema>;

// --- recipes (Admin > Conversions) -------------------------------------------

const emptyToUndefined = (v: unknown) => (v === "" || v === null || v === undefined ? undefined : v);

/**
 * A recipe: what is taken, what is made, and the fixed ratio between them. input_amount : output_amount is counted in the
 * measure each item has at the bench, so 1 : 10 means every 1 mL of the input makes 10 mL of the output. The measure
 * label is the word shown beside the amounts ("mL") and never changes a quantity. A blank shelf life means the
 * output does not expire.
 */
export const recipeInputSchema = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9][A-Z0-9_-]{1,29}$/, "Use 2 to 30 letters, digits, hyphens or underscores"),
  name: z.string().trim().min(1, "Required").max(120),
  inputItemTypeId: z.uuid({ message: "Choose the item that is taken" }),
  outputItemTypeId: z.uuid({ message: "Choose the item that is made" }),
  inputAmount: z.coerce
    .number()
    .int("Enter a whole number")
    .min(1, "The input amount must be at least 1")
    .max(CONVERSION_AMOUNT_MAX, "That amount is too large"),
  outputAmount: z.coerce
    .number()
    .int("Enter a whole number")
    .min(1, "The output amount must be at least 1")
    .max(CONVERSION_AMOUNT_MAX, "That amount is too large"),
  measureLabel: z.string().trim().min(1, "Enter the unit, for example mL").max(20, "Use at most 20 characters"),
  shelfLifeDays: z.preprocess(
    emptyToUndefined,
    z.coerce
      .number()
      .int("Enter a whole number of days")
      .min(1, "The shelf life must be at least 1 day")
      .max(CONVERSION_SHELF_LIFE_MAX_DAYS, `Use at most ${CONVERSION_SHELF_LIFE_MAX_DAYS} days`)
      .optional(),
  ),
});
export type RecipeInput = z.input<typeof recipeInputSchema>;

/** The code is fixed once created, as for locations and item types. */
export const recipeUpdateSchema = recipeInputSchema.omit({ code: true }).extend({ id: z.uuid() });
export type RecipeUpdate = z.input<typeof recipeUpdateSchema>;
