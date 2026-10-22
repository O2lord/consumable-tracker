import { NextResponse } from "next/server";
import { guard } from "@/server/auth/api-guard";
import { signQzRequest } from "@/server/qz/signing";

// POST /api/qz/sign  { "request": "<the text QZ Tray asks to be signed>" }  -> the signature (plain text).
// QZ Tray's library sends the SHA-256 hash of its request, so the server cannot see which call it signs; it signs
// only that hash format, and only for a signed-in user who may print labels (see server/qz/signing.ts).

export async function POST(request: Request) {
  const auth = await guard("issue", "return", "view_reports");
  if (auth.error) return auth.error;

  const body = (await request.json().catch(() => null)) as { request?: unknown } | null;
  if (!body || typeof body.request !== "string") {
    return NextResponse.json({ error: "Nothing to sign" }, { status: 400 });
  }
  const result = signQzRequest(body.request);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return new Response(result.signature, { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
}
