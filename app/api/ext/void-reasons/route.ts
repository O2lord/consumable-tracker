import { NextResponse } from "next/server";
import { apiFailure, guard } from "@/server/auth/api-guard";
import { activeVoidReasons } from "@/server/services/extension.service";

// GET /api/ext/void-reasons -> the reasons offered when a returned bottle is unusable.

export async function GET() {
  const auth = await guard("return", "void");
  if (auth.error) return auth.error;
  try {
    return NextResponse.json({ reasons: await activeVoidReasons() });
  } catch (err) {
    return apiFailure(err);
  }
}
