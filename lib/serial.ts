// Serial and batch codes: a short prefix, 8 random characters and one check character.
//
//   CT 7K2M9QXR 4     (11 characters, Code 128 friendly)
//
// - Alphabet is Crockford base32 (no I, L, O, U), so printed codes are hard to misread.
// - The check character is Luhn mod 32, which catches every single-character typo and
//   most adjacent swaps, so a bad scan or a mistyped serial is rejected before it hits the DB.
// - Uniqueness comes from 32^8 (about 1.1e12) random values, backed by the UNIQUE constraint.

export const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const N = ALPHABET.length; // 32
const BODY_LENGTH = 8;

export const SERIAL_PREFIX = "CT";
export const BATCH_PREFIX = "BT";
export const TRANSFER_PREFIX = "TRF";
export const REQUEST_PREFIX = "REQ";
// No L in the alphabet (it reads as 1), so a delivery is DV rather than DLV.
export const DELIVERY_PREFIX = "DV";
// The label on one pack or roll. Its own prefix, so a pack code can never be read as a bottle serial (CT).
export const PACK_PREFIX = "PK";

export type RandomBytes = (length: number) => Uint8Array;

const defaultRandomBytes: RandomBytes = (length) => globalThis.crypto.getRandomValues(new Uint8Array(length));

/** Uppercases, strips spaces and hyphens, and maps the Crockford look-alikes (O to 0, I and L to 1). */
export function normalizeCode(input: string): string {
  return input
    .trim()
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
}

function luhnModNCheckChar(input: string): string {
  let factor = 2;
  let sum = 0;
  for (let i = input.length - 1; i >= 0; i--) {
    const codePoint = ALPHABET.indexOf(input[i]);
    let addend = factor * codePoint;
    factor = factor === 2 ? 1 : 2;
    addend = Math.floor(addend / N) + (addend % N);
    sum += addend;
  }
  return ALPHABET[(N - (sum % N)) % N];
}

function luhnModNValid(input: string): boolean {
  let factor = 1;
  let sum = 0;
  for (let i = input.length - 1; i >= 0; i--) {
    const codePoint = ALPHABET.indexOf(input[i]);
    if (codePoint < 0) return false;
    let addend = factor * codePoint;
    factor = factor === 2 ? 1 : 2;
    addend = Math.floor(addend / N) + (addend % N);
    sum += addend;
  }
  return sum % N === 0;
}

/** Generates `<prefix><8 random chars><check char>`. The prefix must use alphabet characters only. */
export function generateCode(prefix: string, randomBytes: RandomBytes = defaultRandomBytes): string {
  const bytes = randomBytes(BODY_LENGTH);
  let body = "";
  // 256 is a multiple of 32, so masking gives a uniform choice with no modulo bias.
  for (const byte of bytes) body += ALPHABET[byte & (N - 1)];
  const withPrefix = prefix + body;
  return withPrefix + luhnModNCheckChar(withPrefix);
}

export function generateSerial(randomBytes?: RandomBytes): string {
  return generateCode(SERIAL_PREFIX, randomBytes);
}

export function generateBatchCode(randomBytes?: RandomBytes): string {
  return generateCode(BATCH_PREFIX, randomBytes);
}

/** Printed on the transfer slip, for example TRF7K2M9QXR4 (12 characters). */
export function generateTransferCode(randomBytes?: RandomBytes): string {
  return generateCode(TRANSFER_PREFIX, randomBytes);
}

/** Quoted on screen and on the linked transfer, for example REQ7K2M9QXR4 (12 characters). */
export function generateRequestCode(randomBytes?: RandomBytes): string {
  return generateCode(REQUEST_PREFIX, randomBytes);
}

/** Quoted on screen for a whole supplier delivery, for example DV7K2M9QXR4 (11 characters). */
export function generateDeliveryCode(randomBytes?: RandomBytes): string {
  return generateCode(DELIVERY_PREFIX, randomBytes);
}

/** The barcode on one pack or roll, for example PK7K2M9QXR4 (11 characters). */
export function generatePackCode(randomBytes?: RandomBytes): string {
  return generateCode(PACK_PREFIX, randomBytes);
}

function isValidCode(code: string, prefix: string): boolean {
  const normalized = normalizeCode(code);
  return (
    normalized.length === prefix.length + BODY_LENGTH + 1 &&
    normalized.startsWith(prefix) &&
    luhnModNValid(normalized)
  );
}

export function isValidSerial(serial: string): boolean {
  return isValidCode(serial, SERIAL_PREFIX);
}

export function isValidBatchCode(code: string): boolean {
  return isValidCode(code, BATCH_PREFIX);
}

export function isValidTransferCode(code: string): boolean {
  return isValidCode(code, TRANSFER_PREFIX);
}

export function isValidRequestCode(code: string): boolean {
  return isValidCode(code, REQUEST_PREFIX);
}

export function isValidDeliveryCode(code: string): boolean {
  return isValidCode(code, DELIVERY_PREFIX);
}

export function isValidPackCode(code: string): boolean {
  return isValidCode(code, PACK_PREFIX);
}

/** Canonical transfer code for lookups, or null when malformed or the check character fails. */
export function parseTransferCode(input: string): string | null {
  return isValidTransferCode(input) ? normalizeCode(input) : null;
}

/** Canonical request code for lookups, or null when malformed or the check character fails. */
export function parseRequestCode(input: string): string | null {
  return isValidRequestCode(input) ? normalizeCode(input) : null;
}

/** Canonical delivery code for lookups, or null when malformed or the check character fails. */
export function parseDeliveryCode(input: string): string | null {
  return isValidDeliveryCode(input) ? normalizeCode(input) : null;
}

/** Canonical pack code for lookups, or null when malformed or the check character fails. */
export function parsePackCode(input: string): string | null {
  return isValidPackCode(input) ? normalizeCode(input) : null;
}

/** Canonical form used for lookups; returns null when the serial is malformed or fails the check. */
export function parseSerial(input: string): string | null {
  return isValidSerial(input) ? normalizeCode(input) : null;
}
