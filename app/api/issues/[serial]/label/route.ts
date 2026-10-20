import { NextResponse } from "next/server";
import { apiFailure, guard } from "@/server/auth/api-guard";
import { worksAtOwnLocationOnly } from "@/server/auth/permissions";
import { getIssueLabelData } from "@/server/services/issue.service";
import { renderIssueLabelPdf } from "@/lib/issue-label-pdf";

// GET /api/issues/<serial>/label -> the issue label (PDF) for a bottle that is currently issued.
// A distributor can only print labels for bottles at their own location.

export async function GET(_request: Request, { params }: { params: Promise<{ serial: string }> }) {
  const auth = await guard("issue", "return", "view_reports");
  if (auth.error) return auth.error;
  const { session } = auth;
  const { serial } = await params;

  try {
    const data = await getIssueLabelData(decodeURIComponent(serial));
    if (worksAtOwnLocationOnly(session.role) && data.locationId !== session.homeLocationId) {
      return NextResponse.json({ error: "Bottle not found" }, { status: 404 });
    }
    const bytes = await renderIssueLabelPdf({
      serial: data.serial,
      patientHospitalNo: data.patientHospitalNo,
      references: data.references,
      issuedAt: data.issuedAt,
      collectorType: data.collectorType,
      collectorName: data.collectorName,
      locationName: data.locationName,
    });
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
