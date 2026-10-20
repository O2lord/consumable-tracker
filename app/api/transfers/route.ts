import { NextResponse, type NextRequest } from "next/server";
import { apiFailure, guard } from "@/server/auth/api-guard";
import { worksAtOwnLocationOnly } from "@/server/auth/permissions";
import { TRANSFER_STATUSES, type TransferStatus } from "@/server/domain/types";
import { listTransfers } from "@/server/services/transfer.service";

// GET /api/transfers?status=DISPATCHED,RECEIVING&limit=50 -> recent transfers, newest first.
// A distributor only sees transfers headed to their own location.

export async function GET(request: NextRequest) {
  const auth = await guard("dispatch", "receive", "view_discrepancies", "view_reports");
  if (auth.error) return auth.error;
  const { session } = auth;

  const params = request.nextUrl.searchParams;
  const statuses = (params.get("status") ?? "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  const unknown = statuses.find((s) => !(TRANSFER_STATUSES as readonly string[]).includes(s));
  if (unknown) return NextResponse.json({ error: `Unknown status ${unknown}` }, { status: 400 });

  const limit = Math.min(Math.max(Number(params.get("limit")) || 50, 1), 200);

  try {
    const restrictToHome = worksAtOwnLocationOnly(session.role);
    if (restrictToHome && !session.homeLocationId) return NextResponse.json({ transfers: [] });
    const hidden: TransferStatus[] = ["DRAFT", "CANCELLED"];
    const visible = (statuses.length ? (statuses as TransferStatus[]) : [...TRANSFER_STATUSES]).filter(
      (s) => !restrictToHome || !hidden.includes(s),
    );
    const transfers = await listTransfers({
      statuses: visible,
      toLocationId: restrictToHome ? (session.homeLocationId as string) : undefined,
      limit,
    });
    return NextResponse.json({ transfers });
  } catch (err) {
    return apiFailure(err);
  }
}
