// Field-level encryption for the few columns that hold a patient's hospital number (MRN), and the
// "blind index" that lets the tracker still look a patient up without ever storing the number in the clear.
//
//   encryptField / decryptField   AES-256-GCM. A fresh random IV every time, so the same MRN gives a
//                                 different stored value each time; nothing can be learned by comparing.
//                                 The column name is bound in as authenticated data, so a value copied
//                                 into a different column does not decrypt.
//   mrnBlindIndex                 HMAC-SHA256 of the normalised MRN with a SECOND, separate secret. The same
//                                 MRN always gives the same fingerprint, which is what a lookup or a join
//                                 compares. Without the secret it cannot be reversed or guessed (MRNs follow
//                                 a simple pattern, so a plain hash would be easy to brute-force).
//
// The two secrets live in the app's environment (Netlify environment variables, marked secret), NEVER in the
// database. Whoever gets only the database sees scrambled values and fingerprints.
//
//   FIELD_ENCRYPTION_KEY   base64 of 32 random bytes
//   FIELD_INDEX_KEY        base64 of 32 other random bytes
//
//   Generate one:  node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
//
// Missing keys: in production this throws, so the app can never quietly store the number unprotected.
// Outside production a fixed development key is used and a warning is printed once, so local work and
// tests run without secrets. Never use the development key for real patient data.
//
// No "server-only" import on purpose: the maintenance scripts load this file too. It only uses node:crypto.

import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";

const PREFIX = "enc:v1:";
const IV_BYTES = 12;
const TAG_BYTES = 16;

let warned = false;

function keyFrom(name: "FIELD_ENCRYPTION_KEY" | "FIELD_INDEX_KEY"): Buffer {
  const raw = process.env[name]?.trim();
  if (raw) {
    const key = Buffer.from(raw, "base64");
    if (key.length !== 32) {
      throw new Error(`${name} must be the base64 of exactly 32 bytes (got ${key.length}).`);
    }
    return key;
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error(`${name} is not set. Patient numbers cannot be stored or read without it.`);
  }
  if (!warned) {
    warned = true;
    console.warn(`[field-crypto] ${name} is not set: using a development key. Do not use this with real patient data.`);
  }
  return createHash("sha256").update(`consumables-development-only:${name}`).digest();
}

/** True when the stored value is one of ours (as opposed to old, unencrypted data). */
export function isEncrypted(stored: string): boolean {
  return stored.startsWith(PREFIX);
}

/** Encrypts one value. `context` names the column (for example "links.patient_hospital_no"). */
export function encryptField(plain: string, context: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", keyFrom("FIELD_ENCRYPTION_KEY"), iv);
  cipher.setAAD(Buffer.from(context, "utf8"));
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
}

/**
 * Decrypts one stored value. A value that is not encrypted (data from before encryption was switched on) is
 * returned as it is, so the app keeps working while `scripts/encrypt-existing-patient-fields.ts` catches up.
 */
export function decryptField(stored: string, context: string): string {
  if (!isEncrypted(stored)) return stored;
  const bytes = Buffer.from(stored.slice(PREFIX.length), "base64url");
  if (bytes.length < IV_BYTES + TAG_BYTES) throw new Error(`A stored value in ${context} is damaged.`);
  const iv = bytes.subarray(0, IV_BYTES);
  const tag = bytes.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const body = bytes.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", keyFrom("FIELD_ENCRYPTION_KEY"), iv);
  decipher.setAAD(Buffer.from(context, "utf8"));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
  } catch {
    // Wrong key, wrong column or tampered data. Never include the value in the message.
    throw new Error(`A stored value in ${context} could not be decrypted. Check FIELD_ENCRYPTION_KEY.`);
  }
}

/** The same normalisation as lib/reference-formats.ts normalizeMrn: trim, no spaces, upper case. */
function normalizeForIndex(mrn: string): string {
  return mrn.trim().toUpperCase().replace(/\s+/g, "");
}

/** The searchable fingerprint of an MRN: same MRN in, same fingerprint out; not reversible without the key. */
export function mrnBlindIndex(mrn: string): string {
  return createHmac("sha256", keyFrom("FIELD_INDEX_KEY")).update(`mrn:${normalizeForIndex(mrn)}`).digest("hex");
}

/** The fingerprint for a value that may be missing. */
export function mrnBlindIndexOrNull(mrn: string | null | undefined): string | null {
  return mrn ? mrnBlindIndex(mrn) : null;
}
