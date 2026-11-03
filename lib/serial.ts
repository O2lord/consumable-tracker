// Serial and batch codes: a short prefix, 8 random characters and one check character.
//
//   PT 7K2M9QXR 4     (11 characters, Code 128 friendly)
//
// - A bottle's prefix is its item's label code (PT for a plain tube, ED for an EDTA tube), so the label says what
//   the bottle is. Bottles made before item codes existed start with CT and stay valid.
// - Cartons, packs, batches and deliveries keep their own prefixes (CN, PK, BT, DV). Those, and CT, can never be
//   an item code, so a prefix always says what kind of thing the code is.
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
// The label on one carton, the outer box a supplier ships in. Its own prefix too (CN, never CT).
export const CARTON_PREFIX = "CN";
// One lab conversion (concentrate into a dilute solution). Three letters like TRF and REQ, so it is never read as a
// two-letter code (CN, PK...) and needs no entry in RESERVED_ITEM_CODES.
export const CONVERSION_PREFIX = "CNV";

/** Characters in an item's label code, the first two characters of its bottles' serials. */
export const ITEM_CODE_LENGTH = 2;
/** Letters an item code may use: the code alphabet without its digits, so no I, L, O or U. */
export const ITEM_CODE_LETTERS = ALPHABET.replace(/[0-9]/g, "");
/**
 * Prefixes that already mean something, so no item may use them. CT is what every bottle started with before items
 * had their own codes; those bottles are still valid.
 */
export const RESERVED_ITEM_CODES: readonly string[] = [SERIAL_PREFIX, BATCH_PREFIX, DELIVERY_PREFIX, PACK_PREFIX, CARTON_PREFIX];

/** True for two letters from the code alphabet that are not a reserved prefix. Expects upper case. */
export function isValidItemCode(code: string): boolean {
  return (
    code.length === ITEM_CODE_LENGTH &&
    [...code].every((ch) => ITEM_CODE_LETTERS.includes(ch)) &&
    !RESERVED_ITEM_CODES.includes(code)
  );
}

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

/**
 * A bottle serial. `itemCode` is the item's label code (PT, ED...); leave it out for the old CT prefix.
 */
export function generateSerial(randomBytes?: RandomBytes, itemCode: string = SERIAL_PREFIX): string {
  if (itemCode !== SERIAL_PREFIX && !isValidItemCode(itemCode)) throw new Error(`${itemCode} is not a valid item code`);
  return generateCode(itemCode, randomBytes);
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

/** The barcode on one carton, for example CN7K2M9QXR4 (11 characters). */
export function generateCartonCode(randomBytes?: RandomBytes): string {
  return generateCode(CARTON_PREFIX, randomBytes);
}

/** Quoted on screen and used as the lot of what a conversion makes, for example CNV7K2M9QXR4 (12 characters). */
export function generateConversionCode(randomBytes?: RandomBytes): string {
  return generateCode(CONVERSION_PREFIX, randomBytes);
}

function isValidCode(code: string, prefix: string): boolean {
  const normalized = normalizeCode(code);
  return (
    normalized.length === prefix.length + BODY_LENGTH + 1 &&
    normalized.startsWith(prefix) &&
    luhnModNValid(normalized)
  );
}

/**
 * A bottle serial: an item code (or the old CT prefix), 8 characters and the check character. The prefix cannot be
 * CN, PK, BT or DV, so a carton, pack, batch or delivery code is never read as a bottle.
 */
export function isValidSerial(serial: string): boolean {
  const normalized = normalizeCode(serial);
  if (normalized.length !== ITEM_CODE_LENGTH + BODY_LENGTH + 1) return false;
  const prefix = normalized.slice(0, ITEM_CODE_LENGTH);
  if (prefix !== SERIAL_PREFIX && !isValidItemCode(prefix)) return false;
  return luhnModNValid(normalized);
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

export function isValidCartonCode(code: string): boolean {
  return isValidCode(code, CARTON_PREFIX);
}

export function isValidConversionCode(code: string): boolean {
  return isValidCode(code, CONVERSION_PREFIX);
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

/** Canonical carton code for lookups, or null when malformed or the check character fails. */
export function parseCartonCode(input: string): string | null {
  return isValidCartonCode(input) ? normalizeCode(input) : null;
}

/** Canonical conversion code for lookups, or null when malformed or the check character fails. */
export function parseConversionCode(input: string): string | null {
  return isValidConversionCode(input) ? normalizeCode(input) : null;
}

/** Canonical form used for lookups; returns null when the serial is malformed or fails the check. */
export function parseSerial(input: string): string | null {
  return isValidSerial(input) ? normalizeCode(input) : null;
}
