import { NextResponse } from "next/server";
import { z } from "zod";
import { signInForToken } from "@/server/auth/session";
import { describeSession } from "@/server/services/extension.service";

// POST /api/ext/login { staffId, password } -> tokens for the Chrome extension.
// Same credentials check as the web login; the difference is that the tokens come back in the body
// (the extension keeps them) instead of an httpOnly cookie.

const body = z.object({ staffId: z.string().trim().min(1).max(60), password: z.string().min(1).max(200) });

export async function POST(request: Request) {
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Enter your staff ID and password" }, { status: 400 });

  const result = await signInForToken(parsed.data.staffId, parsed.data.password);
  if (!result.ok) {
    return NextResponse.json({ error: result.message }, { status: result.unavailable ? 503 : 401 });
  }
  const { accessToken, refreshToken, expiresIn, profile } = result.value;
  return NextResponse.json({ accessToken, refreshToken, expiresIn, user: await describeSession(profile) });
}
