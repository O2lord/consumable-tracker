import "server-only";
import { and, eq } from "drizzle-orm";
import { db } from "../db/client";
import { locations, users } from "../db/schema";
import { canWorkAtAnyLocation } from "../auth/permissions";
import { NotFoundError, PermissionDeniedError } from "../domain/errors";
import type { Actor } from "../domain/types";
import type { DbOrTx } from "../audit/events";

// Where a supervisor or admin is working, chosen once in the app bar and used on every page and by the Chrome
// extension. It is stored on the user (not in a cookie) so every tab and device agree. The session turns it into
// `workLocationId` (see server/auth/session.ts), falling back to the home location.

/**
 * Sets the location the person is working at. Only people with the work_any_location permission may choose;
 * everyone else always works at their home location. The location must exist and be active.
 */
export async function setWorkLocation(
  actor: Pick<Actor, "userId" | "role">,
  locationId: string,
  conn: DbOrTx = db(),
): Promise<void> {
  if (!canWorkAtAnyLocation(actor.role)) throw new PermissionDeniedError("You can only work at your own location");
  const [location] = await conn
    .select({ id: locations.id })
    .from(locations)
    .where(and(eq(locations.id, locationId), eq(locations.active, true)));
  if (!location) throw new NotFoundError("Location");
  await conn.update(users).set({ workLocationId: locationId }).where(eq(users.id, actor.userId));
}
