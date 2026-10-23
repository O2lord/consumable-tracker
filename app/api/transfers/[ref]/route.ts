import { NextResponse, type NextRequest } from "next/server";
import { apiFailure, guard } from "@/server/auth/api-guard";
import { worksAtOwnLocationOnly } from "@/server/auth/permissions";
import { getTransferDetail } from "@/server/services/transfer.service";
import { renderSlipPdf, renderTransferLabelPdf } from "@/lib/slip-pdf";

// GET /api/transfers/<code or id>              -> the transfer with its items (JSON)
// GET /api/transfers/<code or id>?format=pdf   -> the transfer slip (only once dispatched)
// GET /api/transfers/<code or id>?format=label -> just the barcode (PDF), 50 x 22 mm, to print and stick on the box
//                                                  (add &sheet=a4 to get it centred on an A4 sheet instead)
//
// A distributor can only open transfers headed to their own location, and while a receipt is
// still open they do not get the dispatched quantity of bulk items (counts stay blind).

export async function GET(request: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  const auth = await guard("dispatch", "receive", "view_discrepancies", "view_reports");
  if (auth.error) return auth.error;
  const { session } = auth;
  const { ref } = await params;

  try {
    const detail = await getTransferDetail(decodeURIComponent(ref));
    if (!detail) return NextResponse.json({ error: "Transfer not found" }, { status: 404 });

    const { transfer } = detail;
    const isDistributor = worksAtOwnLocationOnly(session.role);
    if (isDistributor && (transfer.toLocationId !== session.homeLocationId || transfer.status === "DRAFT" || transfer.status === "CANCELLED")) {
      return NextResponse.json({ error: "Transfer not found" }, { status: 404 });
    }

    const format = request.nextUrl.searchParams.get("format");
    if (format === "label") {
      if (transfer.status === "DRAFT" || transfer.status === "CANCELLED") {
        return NextResponse.json({ error: "The barcode is available once the transfer is dispatched" }, { status: 409 });
      }
      const sheet = request.nextUrl.searchParams.get("sheet") === "a4" ? "a4" : "label";
      const bytes = await renderTransferLabelPdf(transfer.code, { sheet });
      return new Response(bytes as unknown as BodyInit, {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `inline; filename="barcode-${transfer.code}.pdf"`,
          "Cache-Control": "no-store",
        },
      });
    }

    if (format === "pdf") {
      if (transfer.status === "DRAFT" || transfer.status === "CANCELLED") {
        return NextResponse.json({ error: "The slip is available once the transfer is dispatched" }, { status: 409 });
      }
      const bytes = await renderSlipPdf({
        code: transfer.code,
        fromName: detail.fromName,
        toName: detail.toName,
        dispatchedAt: transfer.dispatchedAt,
        dispatchedByName: detail.dispatchedByName,
        serialCount: detail.totals.serialCount,
        quantityTotal: detail.totals.quantityTotal,
        pieceTotal: detail.totals.pieceTotal,
        note: transfer.note,
        parts: detail.parts.map((p) => ({ batchCode: p.batchCode, letter: p.letter })),
      });
      return new Response(bytes as unknown as BodyInit, {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `inline; filename="slip-${transfer.code}.pdf"`,
          "Cache-Control": "no-store",
        },
      });
    }

    const blind = isDistributor && (transfer.status === "DISPATCHED" || transfer.status === "RECEIVING");
    const body = blind
      ? {
          ...detail,
          quantityItems: detail.quantityItems.map((i) => ({ ...i, dispatched: null })),
          totals: { ...detail.totals, quantityTotal: null, pieceTotal: null, all: null },
        }
      : detail;
    return NextResponse.json(body);
  } catch (err) {
    return apiFailure(err);
  }
}
