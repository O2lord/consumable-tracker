import { z } from "zod";
import { parseContainerList } from "../lib/containers";
import {
  COLLECTOR_TYPES,
  ISSUE_RULES,
  PATIENT_TYPES,
  POLICY_PATIENT_TYPES,
  QUANTITY_RETURN_OUTCOMES,
  REFERENCE_TYPES,
  RETURN_OUTCOMES,
} from "../server/domain/types";

// Validation for issue, return and void. Shared by the server actions and the services.

const text = (max: number) => z.string().trim().max(max);
const reasonNote = text(500).optional();

export const referenceInputSchema = z.object({
  type: z.enum(REFERENCE_TYPES),
  ref: z.string().trim().min(1, "Enter the reference number").max(60),
  /** The test this investigation is for; its container requirement comes from the test catalog. */
  testCode: z.string().trim().toUpperCase().max(30).optional(),
  /** Payment status read from the staff portal screen by the extension. Wins over the provider's. */
  reportedPayment: z.enum(["PAID", "UNPAID", "CHARGED_TO_ADMISSION", "unknown"]).optional(),
});
export type ReferenceInput = z.infer<typeof referenceInputSchema>;

const collector = {
  collectorType: z.enum(COLLECTOR_TYPES),
  /** Required unless the patient collects it themselves (the services enforce that); never kept for a patient. */
  collectorName: z.string().trim().max(120).optional(),
};

const override = z.object({ reason: z.string().trim().min(3, "A reason is required for an override").max(500) });

const patient = {
  patientHospitalNo: text(40).optional(),
  patientType: z.enum(PATIENT_TYPES).optional(),
};

/** Issue one bottle to a group of references. One scan links every reference in the group. */
export const issueUnitSchema = z.object({
  serial: z.string().trim().min(1, "Scan the bottle"),
  references: z.array(referenceInputSchema).min(1, "Enter at least one reference").max(20),
  ...patient,
  ...collector,
  locationId: z.uuid().optional(),
  override: override.optional(),
  /** Set by the Chrome extension endpoints: links are recorded with reference_source = 'extension'. */
  source: z.literal("extension").optional(),
});
export type IssueUnitInput = z.infer<typeof issueUnitSchema>;

export const returnUnitSchema = z.object({
  serial: z.string().trim().min(1, "Scan the bottle"),
  outcome: z.enum(RETURN_OUTCOMES),
  reasonCode: z.string().trim().toUpperCase().max(40).optional(),
  note: reasonNote,
  locationId: z.uuid().optional(),
});
export type ReturnUnitInput = z.infer<typeof returnUnitSchema>;

export const returnQuantitySchema = z.object({
  batch: z.string().trim().min(1, "Enter the batch code"),
  quantity: z.coerce.number().int("Enter a whole number").positive("Enter a whole number greater than zero"),
  outcome: z.enum(QUANTITY_RETURN_OUTCOMES),
  reasonCode: z.string().trim().toUpperCase().max(40).optional(),
  note: reasonNote,
  locationId: z.uuid().optional(),
});
export type ReturnQuantityInput = z.infer<typeof returnQuantitySchema>;

export const voidUnitSchema = z.object({
  serial: z.string().trim().min(1, "Scan the bottle"),
  reasonCode: z.string().trim().toUpperCase().min(1, "Choose a reason").max(40),
  note: reasonNote,
  locationId: z.uuid().optional(),
});
export type VoidUnitInput = z.infer<typeof voidUnitSchema>;

export const voidQuantitySchema = z.object({
  batch: z.string().trim().min(1, "Enter the batch code"),
  quantity: z.coerce.number().int("Enter a whole number").positive("Enter a whole number greater than zero"),
  reasonCode: z.string().trim().toUpperCase().min(1, "Choose a reason").max(40),
  note: reasonNote,
  locationId: z.uuid().optional(),
});
export type VoidQuantityInput = z.infer<typeof voidQuantitySchema>;

// --- admin: test catalog and issue policies ------------------------------------

const testCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9][A-Z0-9_-]{1,29}$/, "Use 2 to 30 letters, digits, hyphens or underscores");

const containerType = z
  .string()
  .regex(/^[A-Z0-9_-]{1,30}$/, "Use letters, digits, hyphens or underscores");

export const testInputSchema = z.object({
  code: testCode,
  name: z.string().trim().min(1, "Required").max(120),
  requiredContainerType: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9_-]{1,30}$/, "Use letters, digits, hyphens or underscores")
    .optional(),
  /**
   * Other containers that also satisfy the test, typed as a list ("GEL, EDTA"). Blank means none. The service
   * drops a repeat of the required type and refuses alternates when no container is required.
   */
  alternateContainerTypes: z
    .string()
    .optional()
    .transform((value) => parseContainerList(value))
    .pipe(z.array(containerType).max(8, "At most 8 alternate containers")),
  /** Ticked once the lab has confirmed the container and the alternates. Display only: it blocks nothing. */
  containersConfirmed: z.boolean().default(false),
});
export type TestInput = z.infer<typeof testInputSchema>;

export const testUpdateSchema = testInputSchema.omit({ code: true }).extend({ id: z.uuid() });
export type TestUpdate = z.infer<typeof testUpdateSchema>;

export const policyInputSchema = z.object({
  referenceType: z.enum(REFERENCE_TYPES),
  patientType: z.enum(POLICY_PATIENT_TYPES),
  rule: z.enum(ISSUE_RULES),
});
export type PolicyInput = z.infer<typeof policyInputSchema>;

// --- standard consumption per test ---------------------------------------------

const itemQuantity = z.coerce
  .number()
  .int("Enter a whole number")
  .positive("Enter a whole number greater than zero")
  .max(100000, "That quantity is too large");

const itemLine = z.object({ itemTypeId: z.uuid(), quantity: itemQuantity });

/**
 * An item line on the Issue screen. A pack item can also name the pack its pieces come from (the PK label that was
 * scanned): the pieces then come out of that pack's batch, and the pack's pieces remaining drops.
 */
const issueItemLine = itemLine.extend({ packCode: z.string().trim().max(40).optional() });

/** Refuses the same item twice, so a total is never split across two lines by accident. */
function noRepeatedItems(
  lines: readonly { itemTypeId: string }[],
  ctx: { addIssue: (issue: { code: "custom"; message: string }) => void },
) {
  const seen = new Set<string>();
  for (const line of lines) {
    if (seen.has(line.itemTypeId)) {
      ctx.addIssue({ code: "custom", message: "An item is listed twice. Combine the quantities into one line" });
      return;
    }
    seen.add(line.itemTypeId);
  }
}

/** Admin: the items one run of a test uses. An empty list clears it. */
export const testStandardItemsSchema = z.object({
  testId: z.uuid(),
  items: z.array(itemLine).max(30, "At most 30 items per test").superRefine(noRepeatedItems),
  /** Ticked once the lab has confirmed the list. Display only: it blocks nothing. */
  consumptionConfirmed: z.boolean().default(false),
});
export type TestStandardItemsInput = z.infer<typeof testStandardItemsSchema>;

/**
 * Issue the items for a number of runs of one test to a department. The lines are what the person confirmed on
 * screen (the standard list, possibly edited); the service works out whether they differ from the standard.
 */
export const consumptionIssueSchema = z.object({
  testCode: z.string().trim().toUpperCase().min(1, "Choose a test").max(30),
  testCount: z.coerce.number().int("Enter a whole number").min(1, "Enter at least 1").max(10000, "That is too many tests"),
  /** The department the items are used for. Optional: when left out it defaults to the working location's name. */
  department: z.string().trim().max(60).optional(),
  items: z.array(issueItemLine).min(1, "Add at least one item").max(40, "At most 40 items").superRefine(noRepeatedItems),
  /**
   * The patient's investigation these items were used for (the Issue screen and the extension send it with the
   * bottle). When present the items are linked to that investigation and patient instead of to a department.
   */
  forPatient: z
    .object({
      investigationRef: z.string().trim().min(1).max(60),
      hospitalNo: z.string().trim().min(1).max(40),
      patientType: z.enum(PATIENT_TYPES).optional(),
      reportedPayment: referenceInputSchema.shape.reportedPayment,
      /** 'extension' when the Chrome extension sent it; left out on the web, so the provider's source is recorded. */
      source: z.literal("extension").optional(),
    })
    .optional(),
  locationId: z.uuid().optional(),
});
export type ConsumptionIssueInput = z.infer<typeof consumptionIssueSchema>;

/**
 * Used for test: what the lab used at the bench, entered by the lab (often at the end of the day). There is no
 * patient. Each line is an item and how much of it was used: loose pieces for a pack item ("10 AHG"), the item's
 * own unit otherwise ("1 pack cotton wool"). The service accepts bench supplies only.
 */
export const labUsageSchema = z.object({
  items: z.array(itemLine).min(1, "Add at least one item").max(40, "At most 40 items").superRefine(noRepeatedItems),
  /** The day it was used (YYYY-MM-DD). Left out means today. It can be earlier, so a missed day is filled in later. */
  usedOn: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Enter a valid date")
    .optional(),
  /** Optional: the test or section it was for ("Blood bank", "AHG"), so use can be seen per test without a patient. */
  section: z.string().trim().max(60).optional(),
  locationId: z.uuid().optional(),
});
export type LabUsageInput = z.infer<typeof labUsageSchema>;
