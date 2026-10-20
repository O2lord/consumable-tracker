import { NextResponse } from "next/server";
import { apiFailure, guard } from "@/server/auth/api-guard";
import { unitForPanel } from "@/server/services/extension.service";

// GET /api/ext/unit/<serial> -> the bottle's state, container type and what it is linked to right now.
// The panel uses it on the return screen ("this bottle belongs to the page you are on") and to
// show the container before issuing.

export async function GET(_request: Request, { params }: { params: Promise<{ serial: string }> }) {
  const auth = await guard("issue", "return", "check_labels");
  if (auth.error) return auth.error;
  const { serial } = await params;
  try {
    const unit = await unitForPanel(decodeURIComponent(serial));
    if (!unit) return NextResponse.json({ error: "Bottle not found, or not a valid serial" }, { status: 404 });
    return NextResponse.json(unit);
  } catch (err) {
    return apiFailure(err);
  }
}
