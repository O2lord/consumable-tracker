import { redirect } from "next/navigation";
import { can, canWorkAtAnyLocation } from "@/server/auth/permissions";
import { requireSession, type Session } from "@/server/auth/session";

/**
 * Who may open the request pages: labs (create_request), the store (review_requests) and report
 * readers such as auditors (view_reports, read-only). Everyone else goes back to the dashboard.
 */
export async function requireRequestsAccess(): Promise<Session> {
  const session = await requireSession();
  const allowed =
    can(session.role, "create_request") || can(session.role, "review_requests") || can(session.role, "view_reports");
  if (!allowed) redirect("/dashboard");
  return session;
}

/** True when the person may act at this location: their own, or any location for supervisors and admins. */
export function worksAt(session: Pick<Session, "role" | "homeLocationId">, locationId: string): boolean {
  return canWorkAtAnyLocation(session.role) || session.homeLocationId === locationId;
}

/** Everyone except lab staff and store keepers sees every request (supervisors, admins, auditors). */
export function seesAllRequests(session: Pick<Session, "role">): boolean {
  if (canWorkAtAnyLocation(session.role)) return true;
  return !can(session.role, "create_request") && !can(session.role, "review_requests");
}
