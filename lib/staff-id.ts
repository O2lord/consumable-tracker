// Staff log in with their staff ID, but Supabase Auth identifies people by email.
// We map each staff ID to a synthetic, never-delivered email address.

export const STAFF_EMAIL_DOMAIN = "tracker.local";

/** Canonical staff ID: trimmed and uppercased ("uath/stf/001 " becomes "UATH/STF/001"). */
export function normalizeStaffId(staffId: string): string {
  return staffId.trim().toUpperCase();
}

/**
 * Synthetic login email for a staff ID. Anything that is not a letter or digit becomes a dot,
 * so IDs such as "UATH/STF/001" produce a valid address ("uath.stf.001@tracker.local").
 */
export function staffIdToEmail(staffId: string): string {
  const local = normalizeStaffId(staffId)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ".")
    .replace(/^\.+|\.+$/g, "");
  if (!local) throw new Error("Staff ID must contain at least one letter or digit");
  return `${local}@${STAFF_EMAIL_DOMAIN}`;
}
