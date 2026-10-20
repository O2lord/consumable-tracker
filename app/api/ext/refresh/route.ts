import { NextResponse } from "next/server";
import { z } from "zod";
import { refreshForToken } from "@/server/auth/session";
import { describeSession } from "@/server/services/extension.service";

// POST /api/ext/refresh { refreshToken } -> a fresh access token, so the extension can renew quietly.

const body = z.object({ refreshToken: z.string().min(1).max(500) });

export async function POST(request: Request) {
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Sign in again" }, { status: 400 });

  const result = await refreshForToken(parsed.data.refreshToken);
  if (!result.ok) {
    return NextResponse.json({ error: result.message }, { status: result.unavailable ? 503 : 401 });
  }
  const { accessToken, refreshToken, expiresIn, profile } = result.value;
  return NextResponse.json({ accessToken, refreshToken, expiresIn, user: await describeSession(profile) });
}
