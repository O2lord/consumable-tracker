// One-off: encrypts the patient numbers (MRN) that were stored in the clear before field encryption was
// switched on, and fills the searchable fingerprint (patient_hospital_no_idx) for every row.
//
// Run:  npm run encrypt-existing              (dry run: counts only, changes nothing)
//       npm run encrypt-existing -- --apply   (does it)
//
// Needs DATABASE_URL, FIELD_ENCRYPTION_KEY and FIELD_INDEX_KEY in .env.local. It REFUSES to run without both
// keys, so it can never encrypt real data with the development fallback key. Use the same keys the deployed
// app uses; a value encrypted with a different key can't be read by the app.
//
// Safe to run again: rows that are already encrypted and already have a fingerprint are skipped. Each table
// is converted in a single transaction, so a failure leaves that table exactly as it was.
//
// This cannot reach the ledger (events). Its triggers block updates by design. Older ISSUED events may still
// hold an MRN in their payload; see scripts/reset-test-data.sql for what to do with test data.

import postgres from "postgres";
import { decryptField, encryptField, isEncrypted, mrnBlindIndex } from "../server/security/field-crypto.ts";

const apply = process.argv.includes("--apply");

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is missing. Set it in .env.local first (see server/security/field-crypto.ts).`);
  return value;
}

interface Target {
  table: string;
  /** The column context the app binds this column to (server/db/schema.ts ENC_CONTEXT). */
  context: string;
}

const TARGETS: Target[] = [
  { table: "links", context: "links.patient_hospital_no" },
  { table: "investigation_imports", context: "investigation_imports.patient_hospital_no" },
];

interface Row {
  id: string;
  patient_hospital_no: string;
  patient_hospital_no_idx: string | null;
}

async function main() {
  requireEnv("FIELD_ENCRYPTION_KEY");
  requireEnv("FIELD_INDEX_KEY");
  const sql = postgres(requireEnv("DATABASE_URL"), { prepare: false, max: 1 });

  try {
    for (const { table, context } of TARGETS) {
      const rows = await sql<Row[]>`
        select id, patient_hospital_no, patient_hospital_no_idx
        from consumables.${sql(table)}
        where patient_hospital_no is not null
          and (patient_hospital_no not like 'enc:v1:%' or patient_hospital_no_idx is null)`;

      if (rows.length === 0) {
        console.log(`${table}: nothing to convert.`);
        continue;
      }
      if (!apply) {
        console.log(`${table}: ${rows.length} row(s) would be converted. Run with --apply to do it.`);
        continue;
      }

      await sql.begin(async (tx) => {
        for (const row of rows) {
          // Already-encrypted rows that only lack the fingerprint: decrypt (proves the key is right), then index.
          const plain = isEncrypted(row.patient_hospital_no)
            ? decryptField(row.patient_hospital_no, context)
            : row.patient_hospital_no;
          const stored = isEncrypted(row.patient_hospital_no) ? row.patient_hospital_no : encryptField(plain, context);
          await tx`
            update consumables.${tx(table)}
            set patient_hospital_no = ${stored}, patient_hospital_no_idx = ${mrnBlindIndex(plain)}
            where id = ${row.id}`;
        }
      });
      console.log(`${table}: converted ${rows.length} row(s).`);
    }
    if (!apply) console.log("\nDry run only. Nothing was changed.");
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  // Never print row values; the message from field-crypto already leaves them out.
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
