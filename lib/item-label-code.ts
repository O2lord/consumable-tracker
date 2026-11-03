import { ITEM_CODE_LENGTH, ITEM_CODE_LETTERS, isValidItemCode } from "./serial";

/**
 * Suggests a label code for an item from its name, so its bottles' serials say what they are. The first try is the
 * initials of the first two words (Plain tube -> PT, Butterfly needle -> BN). If that is reserved or already used by
 * another item, it tries other letters of the name, then any free pair. Letters the code alphabet leaves out (I, L,
 * O, U) are skipped. Returns null only when every code is taken.
 *
 * `taken` is the set of codes other items already use (upper case).
 */
export function suggestLabelCode(name: string, taken: ReadonlySet<string>): string | null {
  const words = name
    .toUpperCase()
    .split(/[^A-Z]+/)
    .map((w) => [...w].filter((ch) => ITEM_CODE_LETTERS.includes(ch)).join(""))
    .filter(Boolean);
  const letters = words.join("");
  const first = letters[0] ?? "A";

  const candidates: string[] = [];
  if (words.length >= 2) candidates.push(words[0][0] + words[1][0]);
  if (words[0]) candidates.push(words[0].slice(0, ITEM_CODE_LENGTH));
  for (const ch of letters.slice(1)) candidates.push(first + ch);
  for (const ch of ITEM_CODE_LETTERS) candidates.push(first + ch);
  for (const a of ITEM_CODE_LETTERS) for (const b of ITEM_CODE_LETTERS) candidates.push(a + b);

  return candidates.find((c) => c.length === ITEM_CODE_LENGTH && isValidItemCode(c) && !taken.has(c)) ?? null;
}
