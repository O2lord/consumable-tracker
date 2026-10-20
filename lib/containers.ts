// Which bottle (container type) a test accepts, and whether tests can share one. Pure: no I/O.
//
// A test names one required container and may list alternates (corrections.md, C4): a chemistry test
// that takes either a plain or a gel tube is PLAIN with the alternate GEL. A test with no required
// container accepts any container.

/** Letters, digits, hyphens and underscores, upper case: the form container types are stored in. */
export function normalizeContainer(value: string): string {
  return value.trim().toUpperCase();
}

/** The containers a test accepts: its required type first, then alternates. Empty means any container. */
export function acceptedContainers(
  required: string | null | undefined,
  alternates: readonly string[] | null | undefined,
): string[] {
  const first = required ? normalizeContainer(required) : "";
  if (!first) return [];
  return [...new Set([first, ...(alternates ?? []).map(normalizeContainer).filter(Boolean)])];
}

/**
 * Alternates as they are stored: upper case, no blanks, no repeats, and without the required type itself.
 * With no required type there is nothing to be an alternate to ("any container" already accepts them all).
 */
export function cleanAlternates(
  required: string | null | undefined,
  alternates: readonly string[] | null | undefined,
): string[] {
  const [, ...rest] = acceptedContainers(required, alternates);
  return rest;
}

/** Splits a typed list ("GEL, EDTA" or "GEL EDTA") into container types. */
export function parseContainerList(text: string | null | undefined): string[] {
  return (text ?? "")
    .split(/[\s,;]+/)
    .map(normalizeContainer)
    .filter(Boolean);
}

/**
 * The container types that satisfy every one of the given tests. Each entry is one test's accepted
 * containers; a test that accepts any container (empty entry) puts no limit on the others.
 * Returns null when no test has a requirement (any container will do).
 */
export function sharedContainers(accepted: readonly (readonly string[])[]): string[] | null {
  const limited = accepted.filter((set) => set.length > 0);
  if (limited.length === 0) return null;
  return limited[0].filter((c) => limited.every((set) => set.includes(c)));
}

/**
 * Whether two tests can share one bottle, for the side panel's "also use this bottle" list. Two tests that
 * accept any container can; a test that accepts any container is not mixed with one that has a
 * requirement (the bottle is not known yet); otherwise they need at least one container in common.
 */
export function canShareBottle(a: readonly string[], b: readonly string[]): boolean {
  if (a.length === 0 || b.length === 0) return a.length === b.length;
  return a.some((c) => b.includes(c));
}
