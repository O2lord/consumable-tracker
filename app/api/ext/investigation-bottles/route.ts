import { NextResponse } from "next/server";
import { apiFailure, guard } from "@/server/auth/api-guard";
import { bottlesForInvestigation } from "@/server/services/extension.service";

// GET /api/ext/investigation-bottles?ref=IXS190 -> the bottles already issued for that investigation
// (serial, state, where it is now, when it was issued, and when the link closed, if it did), oldest first.
// The panel uses it to show "sample bottle already collected". An investigation with none returns [].

export async function GET(request: Request) {
  const auth = await guard("issue", "return");
  if (auth.error) return auth.error;
  const ref = new URL(request.url).searchParams.get("ref")?.trim();
  if (!ref) return NextResponse.json({ error: "Missing investigation number" }, { status: 400 });
  try {
    return NextResponse.json({ bottles: await bottlesForInvestigation(ref) });
  } catch (err) {
    return apiFailure(err);
  }
}
