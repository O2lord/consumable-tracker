import { NextResponse } from "next/server";
import { apiFailure, guard } from "@/server/auth/api-guard";
import { getUnitWithHistory } from "@/server/services/unit.service";

// GET /api/units/<serial> -> the bottle and its full event history (read-only)

export async function GET(_request: Request, { params }: { params: Promise<{ serial: string }> }) {
  const auth = await guard("check_labels", "view_reports");
  if (auth.error) return auth.error;
  const { serial } = await params;

  try {
    const result = await getUnitWithHistory(decodeURIComponent(serial));
    if (!result) return NextResponse.json({ error: "Bottle not found, or not a valid serial" }, { status: 404 });
    return NextResponse.json(result);
  } catch (err) {
    return apiFailure(err);
  }
}
