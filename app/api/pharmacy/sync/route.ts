import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { apiFailure, guard } from "@/server/auth/api-guard";
import { env } from "@/server/env";
import { listReconcileRuns, runPharmacyReconcile } from "@/server/services/pharmacy-reconcile.service";

// POST /api/pharmacy/sync -> runs the Pharmacy reconcile now and records it (shadow mode: nothing is blocked).
//   Scheduled call: send `Authorization: Bearer <PHARMACY_SYNC_SECRET>` (a daily cron or Supabase scheduled function).
//   By hand: a signed-in supervisor or auditor (the same people who see the Pharmacy report).
// GET  /api/pharmacy/sync?limit=<n> -> the latest runs, newest first (supervisors and auditors).

function secretMatches(header: string | null): boolean {
  const secret = env().PHARMACY_SYNC_SECRET;
  if (!secret || !header?.startsWith("Bearer ")) return false;
  const given = Buffer.from(header.slice("Bearer ".length).trim());
  const wanted = Buffer.from(secret);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

export async function POST(request: NextRequest) {
  try {
    if (secretMatches(request.headers.get("authorization"))) {
      return NextResponse.json({ run: await runPharmacyReconcile({ triggeredBy: "JOB" }) });
    }
    const auth = await guard("view_reports");
    if (auth.error) return auth.error;
    return NextResponse.json({ run: await runPharmacyReconcile({ triggeredBy: "USER", userId: auth.session.userId }) });
  } catch (err) {
    return apiFailure(err);
  }
}

export async function GET(request: NextRequest) {
  const auth = await guard("view_reports");
  if (auth.error) return auth.error;
  try {
    const limit = Math.min(Math.max(Number(request.nextUrl.searchParams.get("limit")) || 15, 1), 100);
    return NextResponse.json({ runs: await listReconcileRuns(limit) });
  } catch (err) {
    return apiFailure(err);
  }
}
