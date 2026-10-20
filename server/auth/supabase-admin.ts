import "server-only";
import { env } from "../env";
import { ConfigurationError, ValidationError } from "../domain/errors";

// Supabase Auth admin calls (create, delete, reset password), made with the service role key.
// Server only: the key must never reach the browser. scripts/bootstrap-admin.ts has its own copy
// of the create/delete logic because scripts cannot import `server-only` modules.

function config() {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = env();
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new ConfigurationError("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set to manage staff accounts.");
  }
  return { url: SUPABASE_URL.replace(/\/$/, ""), key: SUPABASE_SERVICE_ROLE_KEY };
}

/** New-style secret keys (sb_secret_...) are not JWTs and go in the apikey header only. */
function headers(key: string): Record<string, string> {
  const base = { "Content-Type": "application/json" };
  return key.startsWith("sb_secret_")
    ? { ...base, apikey: key }
    : { ...base, apikey: key, Authorization: `Bearer ${key}` };
}

type AuthBody = { id?: string; msg?: string; message?: string; error_description?: string };

function describe(body: AuthBody): string {
  return body.msg ?? body.message ?? body.error_description ?? "unknown error";
}

/** Creates a confirmed Auth user and returns its id. */
export async function createAuthUser(args: { email: string; password: string; staffId: string }): Promise<string> {
  const { url, key } = config();
  const res = await fetch(`${url}/auth/v1/admin/users`, {
    method: "POST",
    headers: headers(key),
    body: JSON.stringify({
      email: args.email,
      password: args.password,
      email_confirm: true,
      user_metadata: { staff_id: args.staffId },
    }),
    cache: "no-store",
  });
  const body = (await res.json().catch(() => ({}))) as AuthBody;
  if (!res.ok || !body.id) {
    if (res.status === 422) {
      throw new ValidationError(`Could not create the login: ${describe(body)}`);
    }
    throw new Error(`Supabase Auth refused the account (${res.status}): ${describe(body)}`);
  }
  return body.id;
}

/** Best-effort cleanup, used when the tracker row could not be written. */
export async function deleteAuthUser(id: string): Promise<void> {
  const { url, key } = config();
  await fetch(`${url}/auth/v1/admin/users/${id}`, { method: "DELETE", headers: headers(key), cache: "no-store" });
}

export async function setAuthPassword(id: string, password: string): Promise<void> {
  const { url, key } = config();
  const res = await fetch(`${url}/auth/v1/admin/users/${id}`, {
    method: "PUT",
    headers: headers(key),
    body: JSON.stringify({ password }),
    cache: "no-store",
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as AuthBody;
    if (res.status === 422) throw new ValidationError(`Password not accepted: ${describe(body)}`);
    throw new Error(`Supabase Auth refused the password change (${res.status}): ${describe(body)}`);
  }
}
