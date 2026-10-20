import "server-only";
import { NextResponse } from "next/server";
import { getSession, type Session } from "./session";
import { can, type Permission } from "./permissions";
import { DomainError } from "../domain/errors";

// Shared by the JSON/PDF route handlers: sign-in and permission check, and one place that maps
// domain errors to HTTP statuses.

export type Guard = { session: Session; error?: undefined } | { session?: undefined; error: NextResponse };

/** Passes when the signed-in user holds at least one of the listed permissions. */
export async function guard(...anyOf: Permission[]): Promise<Guard> {
  const session = await getSession();
  if (!session) return { error: NextResponse.json({ error: "Sign in first" }, { status: 401 }) };
  if (!anyOf.some((p) => can(session.role, p))) {
    return { error: NextResponse.json({ error: "You are not allowed to do this" }, { status: 403 }) };
  }
  return { session };
}

const STATUS: Record<string, number> = {
  NOT_FOUND: 404,
  PERMISSION_DENIED: 403,
  CONFIGURATION: 500,
  WRONG_TRANSFER: 409,
  WRONG_LOCATION: 409,
  TRANSFER_STATUS: 409,
  REQUEST_STATUS: 409,
  INVALID_TRANSITION: 409,
  ALREADY_ISSUED: 409,
  EXPIRED_STOCK: 409,
  CONTAINER_MISMATCH: 409,
  PAYMENT_REQUIRED: 409,
  PATIENT_MISMATCH: 409,
};

export function apiFailure(err: unknown): NextResponse {
  if (err instanceof DomainError) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: STATUS[err.code] ?? 400 });
  }
  console.error(err);
  return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
}
