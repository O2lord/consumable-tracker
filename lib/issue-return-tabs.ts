import type { Permission } from "@/server/auth/permissions";

/**
 * The four pages that share one tab strip (and one sidebar entry), in tab order, each with the permission that opens it.
 * A layout file cannot export extra values in Next.js, so the list lives here for the layout and the sidebar to share.
 */
export const ISSUE_AND_RETURN_TABS: readonly { label: string; href: string; permission: Permission }[] = [
  { label: "Issue", href: "/distribution/issue", permission: "issue" },
  { label: "Used for test", href: "/distribution/used", permission: "record_usage" },
  { label: "Return", href: "/distribution/return", permission: "return" },
  { label: "Void", href: "/distribution/void", permission: "void" },
];
