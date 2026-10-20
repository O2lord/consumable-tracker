// Loads a Pharmacy export from the command line, the same import the Imports page runs.
//
// Run:  npm run import-pharmacy -- --kind inventory --file ./docs/inventory.xlsx --location MAIN-STORE --as ADMIN01
//       npm run import-pharmacy -- --kind grn --file ./docs/grn-GRNS00002.xlsx --as ADMIN01
//       npm run import-pharmacy -- --kind transfers --file ./docs/transfers.xlsx --as ADMIN01
//
//   --kind      inventory (stock on hand) | grn | transfers
//   --file      path to the .xlsx or .csv export
//   --location  inventory only: the tracker location it is for (code or name). Not needed when the file
//               has a location column.
//   --grn       grn only: the GRN number, when neither a grn_ref column nor the file name carries it
//   --as        staff ID of the person the import is recorded against (must be allowed to manage imports)
//
// Needs DATABASE_URL in .env.local. Re-running with a newer file updates the rows already loaded.

import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { parseArgs } from "node:util";
import { eq } from "drizzle-orm";
import { can } from "../server/auth/permissions";
import { db, sql as pool } from "../server/db/client";
import { locations, users } from "../server/db/schema";
import { ValidationError } from "../server/domain/errors";
import type { PharmacyImportKind } from "../server/domain/types";
import { importPharmacy } from "../server/services/import.service";
import { normalizeStaffId } from "../lib/staff-id";

const KINDS: Record<string, PharmacyImportKind> = {
  inventory: "INVENTORY",
  grn: "GRN_LINE",
  transfers: "TRANSFER",
};

const norm = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

async function main() {
  try {
    process.loadEnvFile(".env.local");
  } catch {
    // No .env.local: rely on the environment as it is.
  }

  // The runner passes only what follows `--`; drop a stray leading `--` if one gets through.
  const argv = process.argv.slice(2).filter((a, i) => !(i === 0 && a === "--"));
  const { values } = parseArgs({
    args: argv,
    options: {
      kind: { type: "string" },
      file: { type: "string" },
      location: { type: "string" },
      grn: { type: "string" },
      as: { type: "string" },
    },
  });

  const kind = KINDS[(values.kind ?? "").toLowerCase()];
  if (!kind) fail("--kind must be inventory, grn or transfers.");
  if (!values.file) fail("--file is required.");
  if (!values.as) fail("--as <staff id> is required: imports are recorded against a person.");

  const conn = db();

  const staffId = normalizeStaffId(values.as);
  const [user] = await conn.select().from(users).where(eq(users.staffId, staffId)).limit(1);
  if (!user) fail(`No user with staff ID ${staffId}.`);
  if (!user.active) fail(`${staffId} is not an active user.`);
  if (!can(user.role, "manage_imports")) fail(`${staffId} (${user.role}) is not allowed to manage imports.`);

  let locationId: string | null = null;
  if (values.location) {
    const want = norm(values.location);
    const all = await conn.select({ id: locations.id, name: locations.name, code: locations.code }).from(locations);
    const hit = all.find((l) => norm(l.code) === want) ?? all.find((l) => norm(l.name) === want);
    if (!hit) fail(`No location with code or name "${values.location}". Known: ${all.map((l) => l.code).join(", ")}`);
    locationId = hit.id;
  }

  const buf = await readFile(values.file).catch(() => fail(`Cannot read ${values.file}.`));
  const data = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;

  const summary = await importPharmacy(
    { kind, fileName: basename(values.file), data, locationId, grnRef: values.grn ?? null },
    { userId: user.id, role: user.role, homeLocationId: user.homeLocationId ?? null },
    conn,
  );

  console.log(
    `${summary.fileName} (${kind}): ${summary.rowsTotal} rows, ${summary.inserted} added, ${summary.updated} updated, ${summary.rejected} rejected.`,
  );
  for (const e of summary.errors) console.log(`  row ${e.row}: ${e.message}`);
  if (summary.rejected > summary.errors.length) {
    console.log(`  ...and ${summary.rejected - summary.errors.length} more (only the first ${summary.errors.length} are kept).`);
  }
}

main()
  .catch((err) => {
    console.error(err instanceof ValidationError || err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool().end({ timeout: 5 });
  });
