import { NextResponse } from "next/server";
import { apiFailure, guard } from "@/server/auth/api-guard";
import { activeLinkedInvestigationRefs } from "@/server/services/extension.service";

// GET /api/ext/active-refs -> the investigation numbers that have a bottle linked right now.
// The panel syncs only these and the investigation open on the portal, so it never sends the rest of
// what the portal loaded. References only: no patient numbers, no names.

export async function GET() {
  const auth = await guard("issue", "return");
  if (auth.error) return auth.error;
  try {
    return NextResponse.json({ refs: await activeLinkedInvestigationRefs() });
  } catch (err) {
    return apiFailure(err);
  }
}
