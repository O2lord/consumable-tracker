import { NextResponse } from "next/server";
import { apiFailure, guard } from "@/server/auth/api-guard";
import { issueFromPortal } from "@/server/services/extension.service";

// POST /api/ext/issue -> issue a bottle to the investigation open on the staff portal.
// Body: { serial, investigationRef, testName, mrn, patientType, payment, collectorType?, collectorName?,
//         locationId?, override?: { reason } }
// Runs the same checks as the Issue page (container, payment policy, patient, location, expiry).

export async function POST(request: Request) {
  const auth = await guard("issue");
  if (auth.error) return auth.error;
  try {
    const result = await issueFromPortal(await request.json().catch(() => null), auth.session);
    return NextResponse.json(result);
  } catch (err) {
    return apiFailure(err);
  }
}
