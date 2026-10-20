// Creates the very first ADMIN account. This is the only record that is seeded: everything else
// (locations, item types, staff, roles) is entered through the admin screens once this admin can log in.
//
// Run:  npm run bootstrap-admin
// Needs SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and DATABASE_URL in .env.local.
// Refuses to run if an ADMIN already exists, so it cannot be used to add accounts later.

import postgres from "postgres";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { normalizeStaffId, staffIdToEmail } from "../lib/staff-id.ts";

const MIN_PASSWORD_LENGTH = 8;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is missing. Fill it in .env.local first.`);
  return value;
}

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/** Reads a line without echoing it. */
async function askHidden(question: string): Promise<string> {
  if (!stdin.isTTY) throw new Error("Run this script in an interactive terminal to enter a password.");
  stdout.write(question);
  return new Promise((resolve) => {
    let value = "";
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          stdout.write("\n");
          resolve(value);
          return;
        }
        if (ch === "\u0003") {
          stdout.write("\n");
          process.exit(130);
        }
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

/**
 * Fails early, with a clear message, when SUPABASE_SERVICE_ROLE_KEY is not an admin key.
 * Supabase answers 403 "User not allowed" when the anon/publishable key is used for admin calls.
 */
function checkServiceKey(key: string): void {
  if (key.startsWith("sb_publishable_")) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY holds a publishable key. Use the secret key (sb_secret_...) or the legacy service_role key from the Supabase dashboard (Project Settings > API Keys).",
    );
  }
  const parts = key.split(".");
  if (parts.length === 3) {
    try {
      const { role } = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as { role?: string };
      if (role && role !== "service_role") {
        throw new Error(
          `SUPABASE_SERVICE_ROLE_KEY is a "${role}" key. Use the service_role key from the Supabase dashboard (Project Settings > API Keys).`,
        );
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("SUPABASE_SERVICE_ROLE_KEY")) throw err;
    }
  }
}

/** New-style secret keys (sb_secret_...) are not JWTs and go in the apikey header only. */
function adminHeaders(key: string): Record<string, string> {
  return key.startsWith("sb_secret_")
    ? { apikey: key }
    : { apikey: key, Authorization: `Bearer ${key}` };
}

async function createAuthUser(
  supabaseUrl: string,
  serviceKey: string,
  email: string,
  password: string,
  staffId: string,
): Promise<string> {
  const res = await fetch(`${supabaseUrl.replace(/\/$/, "")}/auth/v1/admin/users`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...adminHeaders(serviceKey),
    },
    body: JSON.stringify({
      email,
      password,
      email_confirm: true,
      user_metadata: { staff_id: staffId },
    }),
  });
  const body = (await res.json().catch(() => ({}))) as { id?: string; msg?: string; message?: string };
  if (!res.ok || !body.id) {
    throw new Error(`Supabase Auth refused the account (${res.status}): ${body.msg ?? body.message ?? "unknown error"}`);
  }
  return body.id;
}

async function deleteAuthUser(supabaseUrl: string, serviceKey: string, id: string): Promise<void> {
  await fetch(`${supabaseUrl.replace(/\/$/, "")}/auth/v1/admin/users/${id}`, {
    method: "DELETE",
    headers: adminHeaders(serviceKey),
  });
}

async function main() {
  const supabaseUrl = requireEnv("SUPABASE_URL");
  const serviceKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  checkServiceKey(serviceKey);
  const sql = postgres(requireEnv("DATABASE_URL"), { max: 1 });

  try {
    const [{ count }] = await sql<{ count: number }[]>`
      select count(*)::int as count from consumables.users where role = 'ADMIN'
    `;
    if (count > 0) {
      console.error("An ADMIN account already exists. Create further users in the admin screens.");
      process.exitCode = 1;
      return;
    }

    const staffId = normalizeStaffId(await ask("Staff ID: "));
    if (!staffId) throw new Error("Staff ID is required.");
    const email = staffIdToEmail(staffId);
    const name = await ask("Full name: ");
    if (!name) throw new Error("Name is required.");

    const password = await askHidden(`Password (min ${MIN_PASSWORD_LENGTH} characters): `);
    if (password.length < MIN_PASSWORD_LENGTH) {
      throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
    }
    if (password !== (await askHidden("Confirm password: "))) throw new Error("Passwords do not match.");

    const authId = await createAuthUser(supabaseUrl, serviceKey, email, password, staffId);
    try {
      await sql`
        insert into consumables.users (id, staff_id, name, role)
        values (${authId}, ${staffId}, ${name}, 'ADMIN')
      `;
    } catch (err) {
      // Do not leave an Auth user behind without a tracker profile.
      await deleteAuthUser(supabaseUrl, serviceKey, authId);
      throw err;
    }

    console.log(`Created ADMIN ${staffId} (${name}). Log in with this staff ID and password.`);
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
