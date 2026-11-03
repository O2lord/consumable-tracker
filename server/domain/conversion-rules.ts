// Pure rules for lab conversions (concentrate into a dilute solution). No I/O, no framework imports, so they are easy
// to unit-test. conversion.service.ts does the database work and calls these for every decision.
//
// A recipe has a fixed ratio, input_amount : output_amount, in the measure each item is counted in at the bench:
//   * the input is counted in loose pieces when it is a pack item (unit "Pack", pack size above 1), otherwise in its
//     own unit. A 1 L bottle of concentrate is one sealed pack of 1,000 pieces, a piece being 1 mL.
//   * the output is always counted in its own unit (an item in mL with pack size 1), never in pieces or tests.
// 1 : 10 means every 1 mL of the input makes 10 mL of the output.

import { isPackUnit } from "../../lib/pack-size";

/** The most one conversion may make, so the output always fits the ledger's whole-number columns. */
export const MAX_OUTPUT_QUANTITY = 100_000_000;

/** The parts of an item type the rules need. */
export interface ConversionItem {
  name: string;
  trackingMode: string;
  unitOfMeasure: string;
  packSize: number;
  testsPerUnit: number | null;
}

/** How an input item is taken off the shelf. */
export type InputMeasure = { kind: "PIECES"; packSize: number } | { kind: "UNITS" };

/** Why a pair of items cannot make a recipe, or null when they can. Checked when a recipe is saved and again on every conversion. */
export function recipeItemsProblem(input: ConversionItem, output: ConversionItem): string | null {
  if (input.trackingMode !== "QUANTITY") {
    return `${input.name} is a serialized item, so it cannot be converted. Serialized bottles are scanned and issued with Issue`;
  }
  if (input.testsPerUnit !== null) {
    return `${input.name} is counted in tests, so it cannot be converted. Its tests done are recorded under Used for test`;
  }
  if (output.trackingMode !== "QUANTITY") {
    return `${output.name} is a serialized item, so a conversion cannot make it`;
  }
  if (output.testsPerUnit !== null || (isPackUnit(output.unitOfMeasure) && output.packSize > 1)) {
    return `${output.name} is counted in packs of pieces or in tests. What a conversion makes must be counted in one plain unit, such as an item in mL with pack size 1`;
  }
  return null;
}

/** The measure the input is counted in. Call it only for an input that passed recipeItemsProblem. */
export function inputMeasure(input: Pick<ConversionItem, "unitOfMeasure" | "packSize">): InputMeasure {
  return isPackUnit(input.unitOfMeasure) && input.packSize > 1 ? { kind: "PIECES", packSize: input.packSize } : { kind: "UNITS" };
}

function gcd(a: number, b: number): number {
  let x = a;
  let y = b;
  while (y !== 0) [x, y] = [y, x % y];
  return x;
}

/**
 * The smallest input quantity that makes a whole number of output units. Every multiple of it does too, and nothing
 * else does: 1 : 10 has a step of 1, 2 : 5 a step of 2, 4 : 6 a step of 2.
 */
export function conversionStep(ratio: { inputAmount: number; outputAmount: number }): number {
  return ratio.inputAmount / gcd(ratio.inputAmount, ratio.outputAmount);
}

export interface ConversionPlan {
  inputQuantity: number;
  outputQuantity: number;
}

/**
 * What taking `inputQuantity` makes under a recipe's ratio. Refused when it would not make a whole number of output
 * units (the ledger holds whole numbers only) or would make more than MAX_OUTPUT_QUANTITY.
 */
export function planConversion(
  ratio: { inputAmount: number; outputAmount: number },
  inputQuantity: number,
  measureLabel = "pieces",
): ConversionPlan | { error: string } {
  if (!Number.isInteger(inputQuantity) || inputQuantity < 1) return { error: "Enter a whole number, at least 1" };
  if (!Number.isInteger(ratio.inputAmount) || !Number.isInteger(ratio.outputAmount) || ratio.inputAmount < 1 || ratio.outputAmount < 1) {
    return { error: "This recipe has no valid ratio. Ask an admin to check it" };
  }

  const step = conversionStep(ratio);
  if (inputQuantity % step !== 0) {
    const lower = Math.floor(inputQuantity / step) * step;
    const upper = lower + step;
    const near = lower >= step ? `${lower.toLocaleString("en-GB")} or ${upper.toLocaleString("en-GB")}` : upper.toLocaleString("en-GB");
    return {
      error: `This recipe works in whole steps of ${step.toLocaleString("en-GB")} ${measureLabel}, so ${inputQuantity.toLocaleString("en-GB")} does not make a whole amount. Enter ${near}`,
    };
  }

  const outputQuantity = (inputQuantity / step) * (ratio.outputAmount / gcd(ratio.inputAmount, ratio.outputAmount));
  if (outputQuantity > MAX_OUTPUT_QUANTITY) {
    return { error: `That would make more than ${MAX_OUTPUT_QUANTITY.toLocaleString("en-GB")}. Convert a smaller amount` };
  }
  return { inputQuantity, outputQuantity };
}

/** `date` (YYYY-MM-DD) plus `days`, as YYYY-MM-DD. Calendar arithmetic in UTC, so no daylight-saving surprises. */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * When what a conversion makes expires. A recipe with no shelf life makes something that does not expire (null).
 * Otherwise it is the day of conversion plus the shelf life, but never later than the earliest expiry among the input
 * batches it was made from: the working solution is not kept past its concentrate. Dates are YYYY-MM-DD, which sort
 * in date order as plain strings.
 */
export function outputExpiryDate(args: {
  convertedOn: string;
  shelfLifeDays: number | null;
  inputExpiries: readonly (string | null)[];
}): string | null {
  if (args.shelfLifeDays === null) return null;
  const byShelfLife = addDays(args.convertedOn, args.shelfLifeDays);
  const earliestInput = args.inputExpiries.filter((e): e is string => e !== null).sort()[0];
  return earliestInput !== undefined && earliestInput < byShelfLife ? earliestInput : byShelfLife;
}
