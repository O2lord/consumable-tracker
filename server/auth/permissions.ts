// Roles and what they may do (architecture section 12). No I/O, so it is easy to unit-test.
//
// What each role may do lives in the database (consumables.roles), so an admin can edit roles and add
// new ones. The five roles below are the built-in defaults: they seed the table, they are what the
// checks fall back to when a role has not been loaded from the database (unit tests, scripts), and the
// locked Admin role always takes its permissions from here, so no one can lock themselves out.
//
// How the checks learn about a role: whenever a session is loaded, session.ts calls registerRole()
// with that role's current permissions. can() then reads the registry. The registry sits on globalThis
// because Next.js can load this file more than once (page, route handler, server action) and every copy
// must see the same data. Unknown roles get nothing, so a mistake fails closed.

import type { BuiltInRole } from "../domain/types";

export const PERMISSIONS = [
  "view_dashboard",
  // store
  "stock_in",
  "dispatch",
  "view_store_reports",
  // open transfer discrepancies, with the exact missing serials
  "view_discrepancies",
  // who dispatched, received and closed a transfer that has a discrepancy
  "view_discrepancy_people",
  // read-only barcode lookup (store and point of distribution)
  "check_labels",
  // point of distribution (own location)
  "receive",
  "issue",
  // end-of-day entry of what the lab used at the bench, with no patient (Used for test)
  "record_usage",
  "return",
  "void",
  "view_location_stock",
  // count the bulk stock at their own location and post the variance (C7)
  "count_stock",
  // stock requests: a lab asks the store (own location), the store reviews them
  "create_request",
  "review_requests",
  // supervision
  "resolve_discrepancy",
  "approve_override",
  "view_reports",
  // work at every location, not only the person's home location
  "work_any_location",
  // administration
  "manage_users",
  "manage_roles",
  "manage_locations",
  "manage_item_types",
  // target and minimum stock per location (C7)
  "manage_par_levels",
  "manage_policies",
  "manage_test_catalog",
  "manage_void_reasons",
  "manage_imports",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export function isPermission(value: string): value is Permission {
  return (PERMISSIONS as readonly string[]).includes(value);
}

/** How the permissions are named and grouped on the Roles screen. */
export const PERMISSION_GROUPS: readonly {
  title: string;
  items: readonly { permission: Permission; label: string; hint?: string }[];
}[] = [
  {
    title: "General",
    items: [
      { permission: "view_dashboard", label: "See the dashboard" },
      { permission: "check_labels", label: "Check labels", hint: "Read-only barcode lookup" },
      {
        permission: "work_any_location",
        label: "Work at any location",
        hint: "Without this, the person only works at their own home location",
      },
    ],
  },
  {
    title: "Store",
    items: [
      { permission: "stock_in", label: "Stock in" },
      { permission: "dispatch", label: "Dispatch and manage transfers" },
      { permission: "view_store_reports", label: "See store reports" },
      { permission: "review_requests", label: "Review stock requests from labs" },
    ],
  },
  {
    title: "Lab and wards",
    items: [
      { permission: "receive", label: "Receive transfers" },
      { permission: "issue", label: "Issue bottles" },
      {
        permission: "record_usage",
        label: "Record lab usage",
        hint: "End-of-day entry of what the lab used at the bench, with no patient",
      },
      { permission: "return", label: "Return bottles" },
      { permission: "void", label: "Void bottles" },
      { permission: "view_location_stock", label: "See stock at their location" },
      { permission: "count_stock", label: "Count stock", hint: "Count bulk items at their location and post the variance" },
      { permission: "create_request", label: "Request stock from the store" },
    ],
  },
  {
    title: "Oversight",
    items: [
      { permission: "view_discrepancies", label: "See transfer discrepancies" },
      {
        permission: "view_discrepancy_people",
        label: "See who was involved in a discrepancy",
        hint: "Who dispatched, received and closed the transfer",
      },
      { permission: "resolve_discrepancy", label: "Resolve discrepancies" },
      { permission: "approve_override", label: "Approve overrides", hint: "Issue a bottle that does not match the test" },
      { permission: "view_reports", label: "See all reports" },
    ],
  },
  {
    title: "Administration",
    items: [
      { permission: "manage_users", label: "Manage users" },
      { permission: "manage_roles", label: "Manage roles" },
      { permission: "manage_locations", label: "Manage locations" },
      { permission: "manage_item_types", label: "Manage item types" },
      { permission: "manage_par_levels", label: "Manage target stock levels", hint: "Target and minimum per location" },
      { permission: "manage_test_catalog", label: "Manage the test catalog" },
      { permission: "manage_policies", label: "Manage issue policies" },
      { permission: "manage_void_reasons", label: "Manage void reasons" },
      { permission: "manage_imports", label: "Manage imports" },
    ],
  },
];

const STORE_KEEPER: readonly Permission[] = [
  "view_dashboard",
  "stock_in",
  "dispatch",
  "view_store_reports",
  "view_discrepancies",
  "check_labels",
  "review_requests",
  "count_stock",
];

const DISTRIBUTOR: readonly Permission[] = [
  "view_dashboard",
  "receive",
  "issue",
  "record_usage",
  "return",
  "void",
  "view_location_stock",
  "check_labels",
  "create_request",
  "count_stock",
];

/** The Admin role can do everything, so one account can test every screen and action. */
export const ADMIN_PERMISSIONS: readonly Permission[] = [...PERMISSIONS];

export interface DefaultRole {
  code: BuiltInRole;
  name: string;
  description: string;
  permissions: readonly Permission[];
  /** A locked role keeps its permissions from this file and cannot be deleted. */
  locked: boolean;
}

/** Seeds consumables.roles (the SQL migration repeats these lists) and is the fallback for the checks. */
export const DEFAULT_ROLES: readonly DefaultRole[] = [
  {
    code: "STORE_KEEPER",
    name: "Store keeper",
    description: "Receives deliveries into the store, dispatches to the labs and answers their stock requests.",
    permissions: STORE_KEEPER,
    locked: false,
  },
  {
    code: "DISTRIBUTOR",
    name: "Distributor",
    description: "Works at one location: receives, issues, returns and voids bottles, and requests stock.",
    permissions: DISTRIBUTOR,
    locked: false,
  },
  {
    code: "SUPERVISOR",
    name: "Supervisor",
    description: "Everything the store keeper and distributor can do, at any location, plus overrides, resolving discrepancies and all reports.",
    permissions: [...STORE_KEEPER, ...DISTRIBUTOR, "view_discrepancy_people", "resolve_discrepancy", "approve_override", "view_reports", "work_any_location", "manage_par_levels"],
    locked: false,
  },
  {
    code: "AUDITOR",
    name: "Auditor",
    description: "Read-only: dashboard, reports and discrepancies.",
    permissions: ["view_dashboard", "view_reports", "view_discrepancies", "view_discrepancy_people"],
    locked: false,
  },
  {
    code: "ADMIN",
    name: "Admin",
    description: "Does everything: every screen and every action, including overrides and resolving discrepancies, at any location. Cannot be changed or deleted, so there is always someone who can manage the system.",
    permissions: ADMIN_PERMISSIONS,
    locked: true,
  },
];

/** The built-in permission sets, by role code. */
export const ROLE_PERMISSIONS: Record<BuiltInRole, ReadonlySet<Permission>> = Object.fromEntries(
  DEFAULT_ROLES.map((r) => [r.code, new Set<Permission>(r.permissions)]),
) as unknown as Record<BuiltInRole, ReadonlySet<Permission>>;

// --- the registry --------------------------------------------------------------------------------

const REGISTRY_KEY = Symbol.for("consumables.roleRegistry");
type Registry = Map<string, ReadonlySet<Permission>>;

function registry(): Registry {
  const g = globalThis as unknown as Record<symbol, Registry | undefined>;
  return (g[REGISTRY_KEY] ??= new Map());
}

/** Records what a role may do right now. Unknown permission names are ignored. */
export function registerRole(code: string, permissions: readonly string[]): void {
  registry().set(code, new Set(permissions.filter(isPermission)));
}

function permissionsOf(code: string): ReadonlySet<Permission> | undefined {
  return registry().get(code) ?? ROLE_PERMISSIONS[code as BuiltInRole];
}

/** Forgets what was registered, so the built-in defaults apply again. For tests. */
export function resetRoleRegistry(): void {
  registry().clear();
}

export function can(role: string, permission: Permission): boolean {
  return permissionsOf(role)?.has(permission) ?? false;
}

/** Supervisors and admins may work at any location; everyone else only at their own. */
export function canWorkAtAnyLocation(role: string): boolean {
  return can(role, "work_any_location");
}

/**
 * True for staff who receive or issue at one location but neither dispatch from the store nor work
 * anywhere: the built-in Distributor. They only see transfers and bottles at their own location.
 */
export function worksAtOwnLocationOnly(role: string): boolean {
  return (
    (can(role, "receive") || can(role, "issue") || can(role, "return")) &&
    !can(role, "dispatch") &&
    !canWorkAtAnyLocation(role)
  );
}

export interface NavItem {
  label: string;
  href: string;
  /** One permission, or a list where holding any one of them shows the link. */
  permission: Permission | readonly Permission[];
}

// Pages that do not exist yet still appear once built; until then the link would 404,
// so only list routes that exist. Add entries here as each screen lands.
export const NAV_ITEMS: readonly NavItem[] = [
  { label: "Dashboard", href: "/dashboard", permission: "view_dashboard" },
  { label: "Stock in", href: "/store/stock-in", permission: "stock_in" },
  { label: "Transfers", href: "/store/transfers", permission: "dispatch" },
  // Same rule as requireRequestsAccess(): labs, the store, and report readers (read-only).
  { label: "Requests", href: "/store/requests", permission: ["create_request", "review_requests", "view_reports"] },
  { label: "Receive", href: "/distribution/receive", permission: "receive" },
  { label: "Issue", href: "/distribution/issue", permission: "issue" },
  { label: "Used for test", href: "/distribution/used", permission: "record_usage" },
  { label: "Return", href: "/distribution/return", permission: "return" },
  { label: "Stock", href: "/distribution/stock", permission: ["view_location_stock", "count_stock"] },
  { label: "Void", href: "/distribution/void", permission: "void" },
  { label: "Discrepancies", href: "/reports/discrepancies", permission: "view_discrepancies" },
  { label: "Outstanding", href: "/reports/outstanding", permission: "view_reports" },
  { label: "Expiring stock", href: "/reports/expiring", permission: "view_reports" },
  { label: "Count variances", href: "/reports/stock-counts", permission: "view_reports" },
  { label: "Reconciliation", href: "/reports/reconciliation", permission: "view_reports" },
  { label: "Exceptions", href: "/reports/exceptions", permission: "view_reports" },
  { label: "Orphan issues", href: "/reports/orphans", permission: "view_reports" },
  { label: "Bottle history", href: "/reports/bottle", permission: "view_reports" },
  { label: "Label check", href: "/store/label-check", permission: "check_labels" },
  { label: "Users", href: "/admin/users", permission: "manage_users" },
  { label: "Roles", href: "/admin/roles", permission: "manage_roles" },
  { label: "Locations", href: "/admin/locations", permission: "manage_locations" },
  { label: "Item types", href: "/admin/item-types", permission: "manage_item_types" },
  { label: "Target stock", href: "/admin/par-levels", permission: "manage_par_levels" },
  { label: "Void reasons", href: "/admin/void-reasons", permission: "manage_void_reasons" },
  { label: "Test catalog", href: "/admin/test-catalog", permission: "manage_test_catalog" },
  { label: "Issue policies", href: "/admin/issue-policies", permission: "manage_policies" },
  { label: "Imports", href: "/admin/imports", permission: "manage_imports" },
];

export function navFor(role: string): NavItem[] {
  return NAV_ITEMS.filter((item) =>
    typeof item.permission === "string"
      ? can(role, item.permission)
      : item.permission.some((p) => can(role, p)),
  );
}
