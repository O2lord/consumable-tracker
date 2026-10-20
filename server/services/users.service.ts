import "server-only";
import { and, asc, count, eq, inArray, ne } from "drizzle-orm";
import { db } from "../db/client";
import { isUniqueViolation } from "../db/errors";
import { locations, roles, users } from "../db/schema";
import { NotFoundError, ValidationError } from "../domain/errors";
import { createAuthUser, deleteAuthUser, setAuthPassword } from "../auth/supabase-admin";
import { staffIdToEmail } from "../../lib/staff-id";
import type { UserCreateInput, UserUpdateInput } from "../../types/admin";
import type { DbOrTx } from "../audit/events";

// Staff accounts. Passwords live in Supabase Auth; the `users` row holds role and home location.
// The caller checks the manage_users permission and passes the acting admin's id.

export async function listUsers(conn: DbOrTx = db()) {
  return conn
    .select({
      id: users.id,
      staffId: users.staffId,
      name: users.name,
      role: users.role,
      roleName: roles.name,
      active: users.active,
      homeLocationId: users.homeLocationId,
      homeLocationName: locations.name,
    })
    .from(users)
    .innerJoin(roles, eq(users.role, roles.code))
    .leftJoin(locations, eq(users.homeLocationId, locations.id))
    .orderBy(asc(users.staffId));
}

async function assertRoleExists(conn: DbOrTx, code: string) {
  const [role] = await conn.select({ code: roles.code }).from(roles).where(eq(roles.code, code));
  if (!role) throw new ValidationError("That role does not exist. Choose one from the list.");
}

/** Codes of the locked roles (Admin). Their holders are the people who can always manage the system. */
async function lockedRoleCodes(conn: DbOrTx): Promise<string[]> {
  const rows = await conn.select({ code: roles.code }).from(roles).where(eq(roles.locked, true));
  return rows.map((r) => r.code);
}

async function assertActiveLocation(conn: DbOrTx, id: string | undefined) {
  if (!id) return;
  const [loc] = await conn.select({ active: locations.active }).from(locations).where(eq(locations.id, id));
  if (!loc || !loc.active) throw new ValidationError("The home location is not an active location");
}

/** True when `exceptUserId` is not the only active holder of a locked role (an admin). */
async function anotherActiveAdminExists(conn: DbOrTx, exceptUserId: string): Promise<boolean> {
  const locked = await lockedRoleCodes(conn);
  if (locked.length === 0) return false;
  const [row] = await conn
    .select({ n: count() })
    .from(users)
    .where(and(inArray(users.role, locked), eq(users.active, true), ne(users.id, exceptUserId)));
  return (row?.n ?? 0) > 0;
}

async function isLockedRole(conn: DbOrTx, code: string): Promise<boolean> {
  return (await lockedRoleCodes(conn)).includes(code);
}

export async function createUser(input: UserCreateInput, conn: DbOrTx = db()) {
  await assertActiveLocation(conn, input.homeLocationId);
  await assertRoleExists(conn, input.role);

  const [existing] = await conn.select({ id: users.id }).from(users).where(eq(users.staffId, input.staffId));
  if (existing) throw new ValidationError(`Staff ID ${input.staffId} already has an account`);

  const authId = await createAuthUser({
    email: staffIdToEmail(input.staffId),
    password: input.password,
    staffId: input.staffId,
  });
  try {
    const [row] = await conn
      .insert(users)
      .values({
        id: authId,
        staffId: input.staffId,
        name: input.name,
        role: input.role,
        homeLocationId: input.homeLocationId ?? null,
      })
      .returning();
    return row;
  } catch (err) {
    // Do not leave a login behind without a tracker profile.
    await deleteAuthUser(authId).catch(() => undefined);
    if (isUniqueViolation(err)) throw new ValidationError(`Staff ID ${input.staffId} already has an account`);
    throw err;
  }
}

export async function updateUser(input: UserUpdateInput, actorId: string, conn: DbOrTx = db()) {
  const [current] = await conn.select().from(users).where(eq(users.id, input.id));
  if (!current) throw new NotFoundError("User");
  await assertActiveLocation(conn, input.homeLocationId);
  await assertRoleExists(conn, input.role);

  if (current.role !== input.role) {
    if (current.id === actorId) throw new ValidationError("You cannot change your own role");
    if (current.active && (await isLockedRole(conn, current.role)) && !(await anotherActiveAdminExists(conn, current.id))) {
      throw new ValidationError("This is the only active admin, so their role cannot be changed");
    }
  }

  const [row] = await conn
    .update(users)
    .set({ name: input.name, role: input.role, homeLocationId: input.homeLocationId ?? null })
    .where(eq(users.id, input.id))
    .returning();
  return row;
}

/** Deactivating blocks login at once: every request re-checks `active`. History is kept. */
export async function setUserActive(id: string, active: boolean, actorId: string, conn: DbOrTx = db()) {
  const [current] = await conn.select().from(users).where(eq(users.id, id));
  if (!current) throw new NotFoundError("User");
  if (!active) {
    if (current.id === actorId) throw new ValidationError("You cannot deactivate your own account");
    if (current.active && (await isLockedRole(conn, current.role)) && !(await anotherActiveAdminExists(conn, current.id))) {
      throw new ValidationError("This is the only active admin and cannot be deactivated");
    }
  }
  await conn.update(users).set({ active }).where(eq(users.id, id));
}

export async function resetUserPassword(id: string, password: string, conn: DbOrTx = db()) {
  const [current] = await conn.select({ id: users.id }).from(users).where(eq(users.id, id));
  if (!current) throw new NotFoundError("User");
  await setAuthPassword(id, password);
}
