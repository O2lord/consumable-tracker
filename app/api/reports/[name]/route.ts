import { NextResponse, type NextRequest } from "next/server";
import { apiFailure, guard } from "@/server/auth/api-guard";
import {
  endOfDay,
  getReconciliation,
  isIsoDate,
  listIssueOverrides,
  listLedgerMismatches,
  listOutstandingIssued,
  listUnverifiedIssues,
  startOfDay,
} from "@/server/services/report.service";
import { listOpenDiscrepancies } from "@/server/services/discrepancy.service";
import { listStockMismatches, listTransferChecks } from "@/server/services/pharmacy-reconcile.service";

// GET /api/reports/<name> -> a report as JSON (supervisors and auditors).
//   reconciliation?from=YYYY-MM-DD&to=YYYY-MM-DD&location=<id>   (defaults to the last 30 days)
//   outstanding?hours=<n>&location=<id>
//   unverified | overrides | discrepancies | mismatches
//   pharmacy-stock?location=<id>   tracker stock versus the imported Pharmacy inventory
//   pharmacy-transfers?all=1       tracker transfer totals versus imported Pharmacy transfers (all=1 includes agreeing ones)

export async function GET(request: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const auth = await guard("view_reports");
  if (auth.error) return auth.error;
  const { name } = await params;
  const q = request.nextUrl.searchParams;

  try {
    switch (name) {
      case "reconciliation": {
        const toDate = q.get("to") ?? undefined;
        const fromDate = q.get("from") ?? undefined;
        if ((fromDate && !isIsoDate(fromDate)) || (toDate && !isIsoDate(toDate))) {
          return NextResponse.json({ error: "Dates must look like 2026-10-07" }, { status: 400 });
        }
        const to = toDate ? endOfDay(toDate) : new Date();
        const from = fromDate ? startOfDay(fromDate) : new Date(to.getTime() - 30 * 24 * 3600 * 1000);
        return NextResponse.json({
          from,
          to,
          rows: await getReconciliation({ from, to, locationId: q.get("location") ?? undefined }),
        });
      }
      case "outstanding": {
        const hours = q.get("hours") ? Number(q.get("hours")) : undefined;
        if (hours !== undefined && (!Number.isFinite(hours) || hours < 0)) {
          return NextResponse.json({ error: "hours must be a number" }, { status: 400 });
        }
        return NextResponse.json({
          rows: await listOutstandingIssued({ hours, locationId: q.get("location") ?? undefined }),
        });
      }
      case "unverified":
        return NextResponse.json({ rows: await listUnverifiedIssues() });
      case "overrides":
        return NextResponse.json({ rows: await listIssueOverrides() });
      case "discrepancies":
        return NextResponse.json({ rows: await listOpenDiscrepancies() });
      case "mismatches":
        return NextResponse.json({ rows: await listLedgerMismatches() });
      case "pharmacy-stock":
        return NextResponse.json({ rows: await listStockMismatches({ locationId: q.get("location") ?? undefined }) });
      case "pharmacy-transfers":
        return NextResponse.json({ rows: await listTransferChecks({ includeOk: q.get("all") === "1" }) });
      default:
        return NextResponse.json({ error: "Unknown report" }, { status: 404 });
    }
  } catch (err) {
    return apiFailure(err);
  }
}
