import { afterEach, describe, expect, it } from "vitest";
import { USER_ROLES } from "@/server/domain/types";
import {
  DEFAULT_ROLES,
  NAV_ITEMS,
  PERMISSIONS,
  PERMISSION_GROUPS,
  ROLE_PERMISSIONS,
  can,
  canWorkAtAnyLocation,
  navFor,
  registerRole,
  resetRoleRegistry,
  worksAtOwnLocationOnly,
} from "@/server/auth/permissions";

describe("permissions", () => {
  it("defines a permission set for every role", () => {
    for (const role of USER_ROLES) expect(ROLE_PERMISSIONS[role]).toBeDefined();
  });

  it("only grants permissions that exist", () => {
    const known = new Set<string>(PERMISSIONS);
    for (const role of USER_ROLES) {
      for (const permission of ROLE_PERMISSIONS[role]) expect(known.has(permission)).toBe(true);
    }
  });

  it("lets the store keeper stock in and dispatch, but not issue", () => {
    expect(can("STORE_KEEPER", "stock_in")).toBe(true);
    expect(can("STORE_KEEPER", "dispatch")).toBe(true);
    expect(can("STORE_KEEPER", "issue")).toBe(false);
  });

  it("lets the distributor receive, issue, return and void, but not stock in", () => {
    for (const p of ["receive", "issue", "return", "void"] as const) expect(can("DISTRIBUTOR", p)).toBe(true);
    expect(can("DISTRIBUTOR", "stock_in")).toBe(false);
  });

  it("gives the supervisor everything the store keeper and distributor have, plus oversight", () => {
    for (const role of ["STORE_KEEPER", "DISTRIBUTOR"] as const) {
      for (const p of ROLE_PERMISSIONS[role]) expect(can("SUPERVISOR", p)).toBe(true);
    }
    for (const p of ["resolve_discrepancy", "approve_override", "view_reports"] as const) {
      expect(can("SUPERVISOR", p)).toBe(true);
    }
    expect(can("SUPERVISOR", "manage_users")).toBe(false);
  });

  it("keeps the auditor read-only", () => {
    expect(can("AUDITOR", "view_reports")).toBe(true);
    for (const p of ["stock_in", "dispatch", "receive", "issue", "return", "void", "resolve_discrepancy"] as const) {
      expect(can("AUDITOR", p)).toBe(false);
    }
  });

  it("limits administration to the admin, except target stock which the supervisor also manages", () => {
    const manage = PERMISSIONS.filter((p) => p.startsWith("manage_"));
    expect(manage.length).toBeGreaterThan(0);
    // architecture.md: manage_par_levels is given to SUPERVISOR and ADMIN.
    const supervisorAlso: readonly string[] = ["manage_par_levels"];
    for (const p of manage) {
      expect(can("ADMIN", p)).toBe(true);
      for (const role of USER_ROLES.filter((r) => r !== "ADMIN")) {
        expect(can(role, p)).toBe(role === "SUPERVISOR" && supervisorAlso.includes(p));
      }
    }
  });

  it("lets only the distributor create requests and only the store keeper review them", () => {
    expect(can("DISTRIBUTOR", "create_request")).toBe(true);
    expect(can("DISTRIBUTOR", "review_requests")).toBe(false);
    expect(can("STORE_KEEPER", "review_requests")).toBe(true);
    expect(can("STORE_KEEPER", "create_request")).toBe(false);
    expect(can("AUDITOR", "create_request")).toBe(false);
    expect(can("AUDITOR", "review_requests")).toBe(false);
    for (const p of ["create_request", "review_requests"] as const) {
      expect(can("SUPERVISOR", p)).toBe(true);
      expect(can("ADMIN", p)).toBe(true);
    }
  });

  it("shows the dashboard link to every role", () => {
    for (const role of USER_ROLES) expect(navFor(role).map((i) => i.href)).toContain("/dashboard");
  });

  it("lets the admin do everything, including overrides and resolving discrepancies", () => {
    const admin = navFor("ADMIN").map((i) => i.href);
    expect(admin).toEqual(NAV_ITEMS.map((i) => i.href));
    for (const p of PERMISSIONS) expect(can("ADMIN", p)).toBe(true);
  });

  it("lets supervisors and admins work at any location", () => {
    expect(canWorkAtAnyLocation("SUPERVISOR")).toBe(true);
    expect(canWorkAtAnyLocation("ADMIN")).toBe(true);
    for (const role of ["STORE_KEEPER", "DISTRIBUTOR", "AUDITOR"] as const) expect(canWorkAtAnyLocation(role)).toBe(false);
  });

  it("limits only the built-in distributor to their own location", () => {
    expect(worksAtOwnLocationOnly("DISTRIBUTOR")).toBe(true);
    for (const role of ["STORE_KEEPER", "SUPERVISOR", "AUDITOR", "ADMIN"] as const) {
      expect(worksAtOwnLocationOnly(role)).toBe(false);
    }
  });
});

describe("editable roles", () => {
  afterEach(() => resetRoleRegistry());

  it("lists every permission on the Roles screen exactly once", () => {
    const shown = PERMISSION_GROUPS.flatMap((g) => g.items.map((i) => i.permission));
    expect([...shown].sort()).toEqual([...PERMISSIONS].sort());
  });

  it("keeps the seeded role list in step with the built-in permission sets", () => {
    expect(DEFAULT_ROLES.map((r) => r.code).sort()).toEqual([...USER_ROLES].sort());
    for (const r of DEFAULT_ROLES) expect(new Set(r.permissions)).toEqual(new Set(ROLE_PERMISSIONS[r.code]));
    expect(DEFAULT_ROLES.filter((r) => r.locked).map((r) => r.code)).toEqual(["ADMIN"]);
  });

  it("gives a role nothing when it is unknown, so a mistake fails closed", () => {
    expect(can("NO_SUCH_ROLE", "view_dashboard")).toBe(false);
    expect(navFor("NO_SUCH_ROLE")).toEqual([]);
    expect(canWorkAtAnyLocation("NO_SUCH_ROLE")).toBe(false);
  });

  it("uses what was registered for a custom role", () => {
    registerRole("LAB_LEAD", ["view_dashboard", "issue", "void", "work_any_location"]);
    expect(can("LAB_LEAD", "issue")).toBe(true);
    expect(can("LAB_LEAD", "void")).toBe(true);
    expect(can("LAB_LEAD", "stock_in")).toBe(false);
    expect(canWorkAtAnyLocation("LAB_LEAD")).toBe(true);
    expect(worksAtOwnLocationOnly("LAB_LEAD")).toBe(false);
    expect(navFor("LAB_LEAD").map((i) => i.href)).toEqual(["/dashboard", "/distribution/issue", "/distribution/void"]);
  });

  it("limits a custom role to its home location unless it may work anywhere", () => {
    registerRole("WARD_NURSE", ["view_dashboard", "receive"]);
    expect(worksAtOwnLocationOnly("WARD_NURSE")).toBe(true);
    registerRole("WARD_NURSE", ["view_dashboard", "receive", "work_any_location"]);
    expect(worksAtOwnLocationOnly("WARD_NURSE")).toBe(false);
  });

  it("lets an edited built-in role replace its defaults", () => {
    registerRole("AUDITOR", ["view_dashboard"]);
    expect(can("AUDITOR", "view_reports")).toBe(false);
    resetRoleRegistry();
    expect(can("AUDITOR", "view_reports")).toBe(true);
  });

  it("ignores permission names it does not know", () => {
    registerRole("ODD", ["view_dashboard", "fly_a_kite"]);
    expect(can("ODD", "view_dashboard")).toBe(true);
    expect(can("ODD", "fly_a_kite" as never)).toBe(false);
  });
});
