import { NextResponse } from "next/server";
import { apiFailure, guard } from "@/server/auth/api-guard";
import { ValidationError } from "@/server/domain/errors";
import { portalReturnSchema } from "@/server/services/extension.service";
import { returnUnit } from "@/server/services/return.service";

// POST /api/ext/return -> a bottle comes back: { serial, outcome: USED | UNUSED | UNUSABLE, reasonCode?, note? }
// Same rules as the Return page: UNUSABLE needs a reason; UNUSED goes back to stock (or is voided where
// the location does not allow reuse).

export async function POST(request: Request) {
  const auth = await guard("return");
  if (auth.error) return auth.error;
  try {
    const parsed = portalReturnSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
    return NextResponse.json(await returnUnit(parsed.data, auth.session));
  } catch (err) {
    return apiFailure(err);
  }
}
