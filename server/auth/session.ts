import "server-only";
import { cache } from "react";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { env } from "../env";
import { db } from "../db/client";
import { locations, roles, users } from "../db/schema";
import type { UserRole } from "../domain/types";
import { staffIdToEmail, normalizeStaffId } from "../../lib/staff-id";
import { ADMIN_PERMISSIONS, can, canWorkAtAnyLocation, registerRole, type Permission } from "./permissions";

// Session handling on top of Supabase Auth (GoTrue), using its REST API directly.
// Staff log in with their staff ID; it maps to a synthetic email (lib/staff-id.ts).
// The access token lives in an httpOnly cookie and is checked with Supabase on each request,
// then matched to the tracker's own `users` row for role and active status.
//
// Limitation: there is no silent token refresh yet. When the access token expires
// (Supabase default: 1 hour, see Project Settings > JWT), staff log in again.

const ACCESS_COOKIE = "ct-access";

/**
 * How long to wait for each Supabase Auth attempt, and how many attempts to make. A connection that stalls while
 * opening is abandoned early and retried on a fresh one, which rides out a flaky network far better than waiting
 * out one long attempt. A real outage still fails after about AUTH_ATTEMPTS * AUTH_ATTEMPT_TIMEOUT_MS.
 */
const AUTH_ATTEMPT_TIMEOUT_MS = 6000;
const AUTH_ATTEMPTS = 3;

/** fetch with a per-attempt timeout and retries on network errors (not on HTTP error responses). */
async function fetchAuth(input: string, init: Omit<RequestInit, "signal">): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= AUTH_ATTEMPTS; attempt++) {
    try {
      return await fetch(input, { ...init, signal: AbortSignal.timeout(AUTH_ATTEMPT_TIMEOUT_MS) });
    } catch (err) {
      lastErr = err;
      if (attempt < AUTH_ATTEMPTS) console.warn(`[auth] attempt ${attempt}/${AUTH_ATTEMPTS} failed, retrying`);
    }
  }
  throw lastErr;
}

/**
 * The user only ever sees a generic message, so log the real reason (ECONNREFUSED, ENOTFOUND, ETIMEDOUT,
 * a TimeoutError from AbortSignal, a bad DB connection string...) on the server where it can be diagnosed.
 * Node's fetch hides the useful code in `err.cause`.
 */
function logUnreachable(context: string, err: unknown, target?: string) {
  const cause = err instanceof Error ? (err as Error & { cause?: unknown }).cause : undefined;
  console.error(`[auth] ${context}${target ? ` (${target})` : ""}`, {
    name: err instanceof Error ? err.name : typeof err,
    message: err instanceof Error ? err.message : String(err),
    code: (err as { code?: string } | null)?.code,
    cause,
  });
}

/** Thrown when Supabase Auth or the database cannot be reached. Not the same as "not signed in". */
export class ServiceUnavailableError extends Error {
  constructor(message = "Cannot reach the server. Check your connection and try again.") {
    super(message);
    this.name = "ServiceUnavailableError";
  }
}

export interface Session {
  userId: string;
  staffId: string;
  name: string;
  /** The role's code, for example DISTRIBUTOR. Stable; what the permission checks use. */
  role: UserRole;
  /** The role's name as admins have written it, for showing to people. */
  roleName: string;
  /** Where the person belongs. Several checks (receiving, requests, access to a page) rely on this one. */
  homeLocationId: string | null;
  /**
   * Where the person is working right now. For someone who may work at any location it is the one they chose in
   * the app bar, as long as that location is still active; otherwise, and for everyone else, it is their home
   * location. Issue, Return, Void, Used for test, Stock and the Chrome extension all work at this location.
   */
  workLocationId: string | null;
}

function authConfig() {
  const { SUPABASE_URL, SUPABASE_ANON_KEY } = env();
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error("SUPABASE_URL and SUPABASE_ANON_KEY must be set to use login.");
  }
  return { url: SUPABASE_URL.replace(/\/$/, ""), apikey: SUPABASE_ANON_KEY };
}

export type SignInResult = { ok: true } | { ok: false; message: string };

const BAD_CREDENTIALS: SignInResult = { ok: false, message: "Staff ID or password is incorrect." };
const BAD_CREDENTIALS_MESSAGE = "Staff ID or password is incorrect.";

/** Verifies the staff ID and password with Supabase Auth and starts a session. Call from a server action. */
export async function signIn(staffIdInput: string, password: string): Promise<SignInResult> {
  const staffId = normalizeStaffId(staffIdInput);
  if (!staffId || !password) return BAD_CREDENTIALS;

  let email: string;
  try {
    email = staffIdToEmail(staffId);
  } catch {
    return BAD_CREDENTIALS;
  }

  const { url, apikey } = authConfig();
  const UNAVAILABLE: SignInResult = { ok: false, message: "Cannot reach the server. Check your connection and try again." };
  let res: Response;
  const startedAt = Date.now();
  try {
    res = await fetchAuth(`${url}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey },
      body: JSON.stringify({ email, password }),
      cache: "no-store",
    });
    console.info(`[auth] signIn: Supabase responded ${res.status} in ${Date.now() - startedAt}ms`);
  } catch (err) {
    logUnreachable(`signIn: Supabase Auth request failed after ${Date.now() - startedAt}ms`, err, `${url}/auth/v1/token`);
    return UNAVAILABLE;
  }
  if (!res.ok) {
    if (res.status >= 500) return { ok: false, message: "Login is unavailable right now. Try again shortly." };
    return BAD_CREDENTIALS;
  }
  const body = (await res.json()) as { access_token?: string; expires_in?: number; user?: { id?: string } };
  if (!body.access_token || !body.user?.id) return BAD_CREDENTIALS;

  // A valid Supabase login is not enough: the person needs an active tracker account.
  let profile: Session | null;
  try {
    profile = await loadProfile(body.user.id);
  } catch (e) {
    if (e instanceof ServiceUnavailableError) return UNAVAILABLE;
    throw e;
  }
  if (!profile) return { ok: false, message: "This account is not active in the tracker." };

  (await cookies()).set(ACCESS_COOKIE, body.access_token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: body.expires_in ?? 3600,
  });
  return { ok: true };
}

async function loadProfile(userId: string): Promise<Session | null> {
  let rows;
  try {
    rows = await queryProfile(userId);
  } catch (err) {
    logUnreachable("loadProfile: database query failed", err);
    throw new ServiceUnavailableError();
  }
  const [row] = rows;
  if (!row || !row.active) return null;
  return toSession(row);
}

function queryProfile(userId: string) {
  return db()
    .select({
      id: users.id,
      staffId: users.staffId,
      name: users.name,
      role: users.role,
      active: users.active,
      homeLocationId: users.homeLocationId,
      chosenLocationId: users.workLocationId,
      chosenLocationActive: locations.active,
      roleName: roles.name,
      rolePermissions: roles.permissions,
      roleLocked: roles.locked,
    })
    .from(users)
    .innerJoin(roles, eq(roles.code, users.role))
    .leftJoin(locations, eq(locations.id, users.workLocationId))
    .where(eq(users.id, userId))
    .limit(1);
}

function toSession(row: Awaited<ReturnType<typeof queryProfile>>[number]): Session {
  // Read on every request, so editing a role takes effect the next time its people load a page.
  // A locked role (Admin) ignores the stored list, so it can never be edited into a lockout.
  registerRole(row.role, row.roleLocked ? ADMIN_PERMISSIONS : row.rolePermissions);
  // The chosen location only counts for someone who may work anywhere (a role change can take that away) and
  // while it is still active (an admin may have switched it off). Otherwise the person is at their home location.
  const chosen =
    row.chosenLocationId && row.chosenLocationActive && canWorkAtAnyLocation(row.role) ? row.chosenLocationId : null;
  return {
    userId: row.id,
    staffId: row.staffId,
    name: row.name,
    role: row.role,
    roleName: row.roleName,
    homeLocationId: row.homeLocationId,
    workLocationId: chosen ?? row.homeLocationId,
  };
}

/** The signed-in user, or null. Memoised per request. Accepts the cookie, or `Authorization: Bearer` (the Chrome extension). */
export const getSession = cache(async (): Promise<Session | null> => {
  const bearer = (await headers()).get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  const token = bearer || (await cookies()).get(ACCESS_COOKIE)?.value;
  if (!token) return null;

  const { url, apikey } = authConfig();
  let res: Response;
  try {
    res = await fetchAuth(`${url}/auth/v1/user`, {
      headers: { apikey, Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
  } catch (err) {
    // Network down, DNS failure or timeout: we could not check, which is not the same as signed out.
    logUnreachable("getSession: Supabase Auth request failed", err, `${url}/auth/v1/user`);
    throw new ServiceUnavailableError();
  }
  if (res.status >= 500) throw new ServiceUnavailableError();
  if (!res.ok) return null;
  const user = (await res.json()) as { id?: string };
  if (!user.id) return null;

  return loadProfile(user.id);
});

/** Ends the session. Call from a server action. */
export async function signOut(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(ACCESS_COOKIE)?.value;
  jar.delete(ACCESS_COOKIE);
  if (!token) return;
  try {
    const { url, apikey } = authConfig();
    await fetch(`${url}/auth/v1/logout`, {
      method: "POST",
      headers: { apikey, Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
  } catch {
    // The cookie is already gone; revoking the token server-side is best effort.
  }
}

export interface TokenSignIn {
  accessToken: string;
  refreshToken: string | null;
  expiresIn: number;
  profile: Session;
}

async function tokenGrant(
  grant: "password" | "refresh_token",
  body: Record<string, string>,
): Promise<{ ok: true; value: TokenSignIn } | { ok: false; message: string; unavailable: boolean }> {
  const { url, apikey } = authConfig();
  const res = await fetch(`${url}/auth/v1/token?grant_type=${grant}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  if (!res.ok) {
    return res.status >= 500
      ? { ok: false, message: "Login is unavailable right now. Try again shortly.", unavailable: true }
      : { ok: false, message: grant === "password" ? BAD_CREDENTIALS_MESSAGE : "Sign in again.", unavailable: false };
  }
  const data = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    user?: { id?: string };
  };
  if (!data.access_token || !data.user?.id) return { ok: false, message: "Sign in again.", unavailable: false };
  const profile = await loadProfile(data.user.id);
  if (!profile) return { ok: false, message: "This account is not active in the tracker.", unavailable: false };
  return {
    ok: true,
    value: {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? null,
      expiresIn: data.expires_in ?? 3600,
      profile,
    },
  };
}

/** Like signIn, but hands the tokens back instead of setting a cookie. For the Chrome extension. */
export async function signInForToken(staffIdInput: string, password: string) {
  const staffId = normalizeStaffId(staffIdInput);
  if (!staffId || !password) return { ok: false as const, message: BAD_CREDENTIALS_MESSAGE, unavailable: false };
  let email: string;
  try {
    email = staffIdToEmail(staffId);
  } catch {
    return { ok: false as const, message: BAD_CREDENTIALS_MESSAGE, unavailable: false };
  }
  return tokenGrant("password", { email, password });
}

/** Trades a refresh token for a new access token, so a shift is not cut off every hour. */
export async function refreshForToken(refreshToken: string) {
  if (!refreshToken) return { ok: false as const, message: "Sign in again.", unavailable: false };
  return tokenGrant("refresh_token", { refresh_token: refreshToken });
}

/** For pages and layouts: the session, or a redirect to the login page. */
export async function requireSession(): Promise<Session> {
  const session = await getSession();
  if (!session) redirect("/login");
  return session;
}

/** For pages, actions and route handlers: the session, if the role may do this. */
export async function requirePermission(permission: Permission): Promise<Session> {
  const session = await requireSession();
  if (!can(session.role, permission)) redirect("/dashboard");
  return session;
}
