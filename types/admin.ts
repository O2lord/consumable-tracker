import { z } from "zod";
import { EXTERNAL_SYSTEMS, LOCATION_TYPES, PACK_SIZE_MAX, SERVICE_ROLES, TRACKING_MODES } from "../server/domain/types";
import { PERMISSIONS } from "../server/auth/permissions";

// Validation for the admin screens. Shared by the forms (server actions) and the services.
// Codes are stored upper-case so "lab-1" and "LAB-1" cannot both exist.

const code = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9][A-Z0-9_-]{1,29}$/, "Use 2 to 30 letters, digits, hyphens or underscores");

const name = z.string().trim().min(1, "Required").max(120);

// --- locations ---------------------------------------------------------------
export const locationInputSchema = z.object({
  code,
  name,
  type: z.enum(LOCATION_TYPES),
  externalSystem: z.enum(EXTERNAL_SYSTEMS).optional(),
  externalId: z.string().trim().max(100).optional(),
  allowUnusedReuse: z.boolean(),
  /** What the location does for stock. Blank means no restriction. */
  serviceRole: z.enum(SERVICE_ROLES).optional(),
});
export type LocationInput = z.infer<typeof locationInputSchema>;

export const locationUpdateSchema = locationInputSchema.omit({ code: true }).extend({ id: z.uuid() });
export type LocationUpdate = z.infer<typeof locationUpdateSchema>;

// --- item types --------------------------------------------------------------
export const itemTypeInputSchema = z.object({
  code,
  name,
  category: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z][A-Z0-9_]{1,39}$/, "Use letters, digits and underscores, for example SAMPLE_CONTAINER"),
  trackingMode: z.enum(TRACKING_MODES),
  containerType: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9_-]{1,30}$/, "Use letters, digits, hyphens or underscores")
    .optional(),
  unitOfMeasure: z.string().trim().min(1).max(30).default("each"),
  reorderLevel: z.coerce.number().int().min(0).max(1_000_000).default(0),
  pharmacyCatalogId: z.string().trim().max(100).optional(),
  /** Roles this item may be sent to. Empty means anywhere. */
  allowedServiceRoles: z.array(z.enum(SERVICE_ROLES)).default([]),
  /** Display only: changing it never changes a stock count or an event. */
  packSize: z.coerce.number().int().min(1).max(PACK_SIZE_MAX).default(1),
  /** Ticked once someone has checked the pack size with the lab. */
  packSizeConfirmed: z.boolean().default(false),
  /** Display only: shows a "Keep cold" tag. It blocks nothing. */
  coldStorage: z.boolean().default(false),
  /** A shared bench supply: issued in bulk and counted, never listed against a test or a patient. */
  benchSupply: z.boolean().default(false),
});
export type ItemTypeInput = z.infer<typeof itemTypeInputSchema>;

export const itemTypeUpdateSchema = itemTypeInputSchema.omit({ code: true }).extend({ id: z.uuid() });
export type ItemTypeUpdate = z.infer<typeof itemTypeUpdateSchema>;

// --- void reasons ------------------------------------------------------------
export const voidReasonInputSchema = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z][A-Z0-9_]{1,39}$/, "Use letters, digits and underscores"),
  label: z.string().trim().min(1, "Required").max(200),
});
export type VoidReasonInput = z.infer<typeof voidReasonInputSchema>;

export const voidReasonUpdateSchema = z.object({
  id: z.uuid(),
  label: z.string().trim().min(1, "Required").max(200),
});

// --- roles -------------------------------------------------------------------
/** A role's code. Whether it exists is checked where it is used. */
const roleCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z][A-Z0-9_]{1,39}$/, "Choose a role");

export const roleInputSchema = z.object({
  name: z.string().trim().min(1, "Required").max(60, "Use at most 60 characters"),
  description: z.string().trim().max(300, "Use at most 300 characters").default(""),
  permissions: z.array(z.enum(PERMISSIONS)).default([]),
});
export type RoleInput = z.infer<typeof roleInputSchema>;

export const roleUpdateSchema = roleInputSchema.extend({ code: roleCode });
export type RoleUpdate = z.infer<typeof roleUpdateSchema>;

export const roleDeleteSchema = z.object({ code: roleCode });

// --- users -------------------------------------------------------------------
export const MIN_PASSWORD_LENGTH = 8;

// GoTrue hashes with bcrypt, which ignores everything after 72 bytes.
const password = z
  .string()
  .min(MIN_PASSWORD_LENGTH, `Use at least ${MIN_PASSWORD_LENGTH} characters`)
  .max(72, "Use at most 72 characters");

export const userCreateSchema = z.object({
  staffId: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9][A-Z0-9/._-]{1,49}$/, "Use letters, digits and / . _ - only"),
  name,
  role: roleCode,
  homeLocationId: z.uuid().optional(),
  password,
});
export type UserCreateInput = z.infer<typeof userCreateSchema>;

export const userUpdateSchema = z.object({
  id: z.uuid(),
  name,
  role: roleCode,
  homeLocationId: z.uuid().optional(),
});
export type UserUpdateInput = z.infer<typeof userUpdateSchema>;

export const passwordResetSchema = z.object({ id: z.uuid(), password });

/** Used by the activate/deactivate buttons: the hidden field arrives as "true" or "false". */
export const setActiveSchema = z.object({
  id: z.uuid(),
  active: z.enum(["true", "false"]).transform((v) => v === "true"),
});
