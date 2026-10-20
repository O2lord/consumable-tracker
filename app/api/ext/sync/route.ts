import { NextResponse } from "next/server";
import { apiFailure, guard } from "@/server/auth/api-guard";
import { syncPortalBatch, syncPortalInvestigation } from "@/server/services/extension.service";

// POST /api/ext/sync -> record what the staff portal shows: creates an investigation the first time it is
// seen, then keeps its status, invoice number and progress (started / prepared / verified times and who) current.
// No export file is needed.
// Body: { items: [ { investigationRef, mrn, testName?, patientType?, status?, invoice?, portalId?, startedAt?, ... } ] }
//       (up to 50; one refused row never stops the others), or a single such object.
// Never writes payment or result values, and refuses a different patient's row.

export async function POST(request: Request) {
  const auth = await guard("issue", "return");
  if (auth.error) return auth.error;
  try {
    const body = await request.json().catch(() => null);
    const isBatch = typeof body === "object" && body !== null && "items" in body;
    const result = isBatch ? await syncPortalBatch(body, auth.session) : await syncPortalInvestigation(body, auth.session);
    return NextResponse.json(result);
  } catch (err) {
    return apiFailure(err);
  }
}
