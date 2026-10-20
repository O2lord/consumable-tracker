// Helpers for turning HTML form submissions into plain objects that Zod can validate.
// Pure: no framework imports, so it is unit-testable and usable from client and server.

/**
 * Converts FormData to an object. Blank text fields become `undefined` (so optional Zod fields
 * work), values are otherwise kept as typed (Zod trims where it needs to; passwords stay exact).
 * Names listed in `checkboxes` become booleans, because unticked boxes are absent from FormData.
 * Names listed in `multi` become arrays of every submitted value (a group of ticked boxes sharing one name),
 * empty when none are ticked.
 */
export function formDataToObject(
  formData: FormData,
  checkboxes: readonly string[] = [],
  multi: readonly string[] = [],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of formData.entries()) {
    if (typeof value !== "string") continue;
    if (key.startsWith("$ACTION")) continue; // injected by Next for server actions
    out[key] = value.trim() === "" ? undefined : value;
  }
  for (const name of checkboxes) out[name] = formData.get(name) === "on";
  for (const name of multi) {
    out[name] = formData.getAll(name).filter((v): v is string => typeof v === "string" && v.trim() !== "");
  }
  return out;
}

interface IssueLike {
  path: readonly PropertyKey[];
  message: string;
}

/** One readable line from a Zod error, for showing under a form. */
export function issuesToMessage(error: { issues: readonly IssueLike[] }): string {
  return error.issues
    .map((issue) => {
      const field = issue.path.length ? String(issue.path[issue.path.length - 1]) : "";
      return field ? `${field}: ${issue.message}` : issue.message;
    })
    .join("; ");
}
