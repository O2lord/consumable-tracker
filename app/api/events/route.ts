import { NextResponse, type NextRequest } from "next/server";
import { apiFailure, guard } from "@/server/auth/api-guard";
import { listEvents } from "@/server/services/event.service";
import { processSyncEvents } from "@/server/services/sync.service";
import { syncRequestSchema } from "@/types/sync";

// GET  /api/events?serial=CT...        -> events for one bottle, newest first
// GET  /api/events?transfer=TRF...     -> events for one transfer
// POST /api/events { events: [...] }   -> scans queued on a device (offline sync). Each one is
//                                         applied idempotently by its id and re-checked against the
//                                         current state; the reply says what happened to each.

export async function GET(request: NextRequest) {
  const auth = await guard("view_reports", "view_discrepancies", "view_store_reports");
  if (auth.error) return auth.error;

  const params = request.nextUrl.searchParams;
  try {
    const rows = await listEvents({
      serial: params.get("serial") ?? undefined,
      transfer: params.get("transfer") ?? undefined,
      limit: Number(params.get("limit")) || undefined,
    });
    return NextResponse.json({ events: rows });
  } catch (err) {
    return apiFailure(err);
  }
}

export async function POST(request: NextRequest) {
  const auth = await guard("receive");
  if (auth.error) return auth.error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Send JSON like { events: [...] }" }, { status: 400 });
  }
  const parsed = syncRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Those events are not in the expected format" }, { status: 400 });
  }

  try {
    const results = await processSyncEvents(parsed.data.events, auth.session);
    return NextResponse.json({ results });
  } catch (err) {
    return apiFailure(err);
  }
}
