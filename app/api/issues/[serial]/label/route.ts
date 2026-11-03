import { NextResponse } from "next/server";
import { apiFailure, guard } from "@/server/auth/api-guard";
import { worksAtOwnLocationOnly } from "@/server/auth/permissions";
import { getIssueLabelData } from "@/server/services/issue.service";
import { renderIssueLabelPdf } from "@/lib/issue-label-pdf";
import { issueLabelToTspl } from "@/lib/tspl";

// GET /api/issues/<serial>/label[?format=pdf|tspl]  -> the issue label for a bottle that is currently issued (PDF by
// default; tspl is what a phone or tablet sends to the USB label printer).
// A distributor can only print labels for bottles at their own location.

export async function GET(request: Request, { params }: { params: Promise<{ serial: string }> }) {
  const auth = await guard("issue", "return", "view_reports");
  if (auth.error) return auth.error;
  const { session } = auth;
  const { serial } = await params;

  try {
    const data = await getIssueLabelData(decodeURIComponent(serial));
    if (worksAtOwnLocationOnly(session.role) && data.locationId !== session.homeLocationId) {
      return NextResponse.json({ error: "Bottle not found" }, { status: 404 });
    }
    const label = {
      serial: data.serial,
      patientHospitalNo: data.patientHospitalNo,
      references: data.references,
      issuedAt: data.issuedAt,
      collectorType: data.collectorType,
      collectorName: data.collectorName,
      locationName: data.locationName,
    };
    if (new URL(request.url).searchParams.get("format") === "tspl") {
      return new Response(issueLabelToTspl(label), {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Content-Disposition": `attachment; filename="issue-${data.serial}.tspl"`,
          "Cache-Control": "no-store",
        },
      });
    }
    const bytes = await renderIssueLabelPdf(label);
    return new Response(bytes as unknown as BodyInit, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="issue-${data.serial}.pdf"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return apiFailure(err);
  }
}
