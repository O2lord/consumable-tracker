import "server-only";
import { asc, count, eq } from "drizzle-orm";
import { db } from "../db/client";
import { isUniqueViolation } from "../db/errors";
import { roles, users } from "../db/schema";
import { NotFoundError, ValidationError } from "../domain/errors";
import { ADMIN_PERMISSIONS, PERMISSIONS, isPermission, type Permission } from "../auth/permissions";
import type { RoleInput, RoleUpdate } from "../../types/admin";
import type { DbOrTx } from "../audit/events";

// Roles: what each kind of staff member may do. Admins edit them under Admin > Roles.
// The caller checks the manage_roles permission.
//
// A role has a code that never changes (users point at it) and a name that can be edited freely.
// The Admin role is locked: its permissions come from the application code and it cannot be deleted,
// so there is always a role that can manage users and roles.

export interface RoleRow {
  code: string;
  name: string;
  description: string;
  /** What the role grants right now. For a locked role this is the fixed list, whatever is stored. */
  permissions: Permission[];
  locked: boolean;
  userCount: number;
}

/** The stored list, cleaned: known permissions only, each once, in the order the screen shows them. */
function cleanPermissions(list: readonly string[]): Permission[] {
  const wanted = new Set(list.filter(isPermission));
  return PERMISSIONS.filter((p) => wanted.has(p));
}

export async function listRoles(conn: DbOrTx = db()): Promise<RoleRow[]> {
  const rows = await conn
    .select({
      code: roles.code,
      name: roles.name,
      description: roles.description,
      permissions: roles.permissions,
      locked: roles.locked,
      userCount: count(users.id),
    })
    .from(roles)
    .leftJoin(users, eq(users.role, roles.code))
    .groupBy(roles.code)
    .orderBy(asc(roles.name));
  return rows.map((r) => ({
    ...r,
    permissions: r.locked ? [...ADMIN_PERMISSIONS] : cleanPermissions(r.permissions),
  }));
}

/** Name and code of every role, for the dropdown on the Users screen. */
export async function listRoleOptions(conn: DbOrTx = db()) {
  return conn.select({ code: roles.code, name: roles.name }).from(roles).orderBy(asc(roles.name));
}

/** A code for a new role: the name in capitals with underscores, made unique with a number if needed. */
async function newRoleCode(conn: DbOrTx, name: string): Promise<string> {
  let base = name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 34);
  if (!/^[A-Z]/.test(base)) base = `ROLE_${base}`.replace(/_+$/, "");
  if (base.length < 2) base = "ROLE";
  const taken = new Set((await conn.select({ code: roles.code }).from(roles)).map((r) => r.code));
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}_${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new ValidationError("Could not make a code for this role. Try a different name.");
}

export async function createRole(input: RoleInput, conn: DbOrTx = db()) {
  const code = await newRoleCode(conn, input.name);
  try {
    const [row] = await conn
      .insert(roles)
      .values({
        code,
        name: input.name,
        description: input.description,
        permissions: cleanPermissions(input.permissions),
        locked: false,
      })
      .returning();
    return row;
  } catch (err) {
    if (isUniqueViolation(err)) throw new ValidationError(`A role called "${input.name}" already exists`);
    throw err;
  }
}

export async function updateRole(input: RoleUpdate, conn: DbOrTx = db()) {
  const [current] = await conn.select().from(roles).where(eq(roles.code, input.code));
  if (!current) throw new NotFoundError("Role");
  try {
    const [row] = await conn
      .update(roles)
      .set({
        name: input.name,
        description: input.description,
        // A locked role keeps its permissions: only its name and description can change.
        permissions: current.locked ? current.permissions : cleanPermissions(input.permissions),
      })
      .where(eq(roles.code, input.code))
      .returning();
    return row;
  } catch (err) {
    if (isUniqueViolation(err)) throw new ValidationError(`A role called "${input.name}" already exists`);
    throw err;
  }
}

export async function deleteRole(code: string, conn: DbOrTx = db()) {
  const [current] = await conn.select().from(roles).where(eq(roles.code, code));
  if (!current) throw new NotFoundError("Role");
  if (current.locked) throw new ValidationError(`${current.name} cannot be deleted`);
  const [held] = await conn.select({ n: count() }).from(users).where(eq(users.role, code));
  const n = held?.n ?? 0;
  if (n > 0) {
    throw new ValidationError(
      `${n} ${n === 1 ? "person has" : "people have"} the role ${current.name}. Give them another role first.`,
    );
  }
  await conn.delete(roles).where(eq(roles.code, code));
}
