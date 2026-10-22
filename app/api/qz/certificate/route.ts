import { NextResponse } from "next/server";
import { guard } from "@/server/auth/api-guard";
import { qzCertificate } from "@/server/qz/signing";

// GET /api/qz/certificate -> the public certificate QZ Tray checks signed print requests against.
// 404 when signing is not set up (QZ_CERTIFICATE / QZ_PRIVATE_KEY, see scripts/qz/README.md): the app then prints
// without a signature and QZ Tray asks for approval each time.

export async function GET() {
  const auth = await guard("issue", "return", "view_reports");
  if (auth.error) return auth.error;
  const certificate = qzCertificate();
  if (!certificate) return NextResponse.json({ error: "QZ signing is not set up on this server" }, { status: 404 });
  return new Response(certificate, { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
}
