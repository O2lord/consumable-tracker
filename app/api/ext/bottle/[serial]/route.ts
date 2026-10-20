import { NextResponse } from "next/server";
import { apiFailure, guard } from "@/server/auth/api-guard";
import { bottleForPanel } from "@/server/services/extension.service";

// GET /api/ext/bottle/<serial> -> everything about one bottle for the panel's Look up screen: where it has been,
// the tests it was used for, and each test's status and release times. Result values are never included;
// the panel links to the portal's own Results tab for those.

export async function GET(_request: Request, { params }: { params: Promise<{ serial: string }> }) {
  const auth = await guard("issue", "return", "check_labels", "view_reports");
  if (auth.error) return auth.error;
  const { serial } = await params;
  try {
    const bottle = await bottleForPanel(decodeURIComponent(serial));
    if (!bottle) return NextResponse.json({ error: "Bottle not found, or not a valid serial" }, { status: 404 });
    return NextResponse.json(bottle);
  } catch (err) {
    return apiFailure(err);
  }
}
