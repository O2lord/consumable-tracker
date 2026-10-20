import "server-only";
import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { locations, roles, users } from "../db/schema";
import { NotFoundError } from "../domain/errors";

// The signed-in person's own profile. Read-only: names, roles and locations are changed by an admin
// under Admin > Users, so there is nothing here to validate or audit.

export interface Profile {
  id: string;
  staffId: string;
  name: string;
  roleCode: string;
  roleName: string;
  roleDescription: string;
  homeLocationName: string | null;
  homeLocationCode: string | null;
  active: boolean;
  createdAt: Date;
}

export async function getProfile(userId: string): Promise<Profile> {
  const [row] = await db()
    .select({
      id: users.id,
      staffId: users.staffId,
      name: users.name,
      roleCode: users.role,
      roleName: roles.name,
      roleDescription: roles.description,
      homeLocationName: locations.name,
      homeLocationCode: locations.code,
      active: users.active,
      createdAt: users.createdAt,
    })
    .from(users)
    .innerJoin(roles, eq(users.role, roles.code))
    .leftJoin(locations, eq(users.homeLocationId, locations.id))
    .where(eq(users.id, userId))
    .limit(1);
  if (!row) throw new NotFoundError("Profile not found");
  return row;
}
