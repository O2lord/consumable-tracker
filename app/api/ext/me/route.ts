import { NextResponse } from "next/server";
import { guard } from "@/server/auth/api-guard";
import { describeSession } from "@/server/services/extension.service";

// GET /api/ext/me -> who is signed in, where they work and what they may do (for the panel header).

export async function GET() {
  const auth = await guard("issue", "return", "check_labels");
  if (auth.error) return auth.error;
  return NextResponse.json(await describeSession(auth.session));
}
