import { NextResponse, type NextRequest } from "next/server";
import { getSession } from "@/server/auth/session";
import { can } from "@/server/auth/permissions";
import { DomainError } from "@/server/domain/errors";
import { printLabels, renderPdf, renderTspl, renderTsplPreview, renderZpl, type LabelTarget } from "@/server/services/labels.service";

// GET  /api/labels?batch=BT...|serial=CT...|delivery=DV...&format=pdf|zpl|tspl|preview[&layout=label|a4][&only=...]  -> file
// POST /api/labels  { batch } or { serial } or { delivery }, with optional { only }                       -> prints (USB queue as TSPL, or network Zebra as ZPL)
//
// `only` narrows a delivery to its own label (delivery) or its batch labels (batches), and a batch to its own
// label (batch) or the pack, roll or bottle labels under it (items). Leave it out for everything together.

async function authorize() {
  const session = await getSession();
  if (!session) return { error: NextResponse.json({ error: "Sign in first" }, { status: 401 }) };
  if (!can(session.role, "stock_in") && !can(session.role, "view_location_stock")) {
    return { error: NextResponse.json({ error: "You are not allowed to print labels" }, { status: 403 }) };
  }
  return { session };
}

function targetFrom(
  batch: unknown,
  serial: unknown,
  delivery: unknown,
  only: unknown,
): LabelTarget | { error: string } | null {
  const scope = typeof only === "string" && only ? only : undefined;
  if (typeof batch === "string" && batch) {
    if (scope === undefined) return { batch };
    if (scope === "batch" || scope === "items") return { batch, only: scope };
    return { error: "For a batch, only must be batch or items" };
  }
  if (typeof serial === "string" && serial) return { serial };
  if (typeof delivery === "string" && delivery) {
    if (scope === undefined) return { delivery };
    if (scope === "delivery" || scope === "batches") return { delivery, only: scope };
    return { error: "For a delivery, only must be delivery or batches" };
  }
  return null;
}

function failure(err: unknown) {
  if (err instanceof DomainError) {
    const status = err.code === "NOT_FOUND" ? 404 : err.code === "CONFIGURATION" ? 500 : 400;
    return NextResponse.json({ error: err.message }, { status });
  }
  console.error(err);
  return NextResponse.json({ error: "Could not produce the labels" }, { status: 500 });
}

export async function GET(request: NextRequest) {
  const auth = await authorize();
  if (auth.error) return auth.error;

  const params = request.nextUrl.searchParams;
  const target = targetFrom(params.get("batch"), params.get("serial"), params.get("delivery"), params.get("only"));
  if (!target) return NextResponse.json({ error: "Give a batch, a serial or a delivery" }, { status: 400 });
  if ("error" in target) return NextResponse.json({ error: target.error }, { status: 400 });

  const format = params.get("format") ?? "pdf";
  try {
    if (format === "zpl") {
      const { zpl, name } = await renderZpl(target);
      return new Response(zpl, {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Content-Disposition": `attachment; filename="labels-${name}.zpl"`,
          "Cache-Control": "no-store",
        },
      });
    }
    if (format === "preview") {
      const { html } = await renderTsplPreview(target);
      return new Response(html, {
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
      });
    }
    if (format === "tspl") {
      const { tspl, name } = await renderTspl(target);
      return new Response(tspl, {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Content-Disposition": `attachment; filename="labels-${name}.tspl"`,
          "Cache-Control": "no-store",
        },
      });
    }
    if (format === "pdf") {
      const layout = params.get("layout") === "a4" ? "a4" : "label";
      const { bytes, name } = await renderPdf(target, layout);
      return new Response(bytes as unknown as BodyInit, {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `inline; filename="labels-${name}.pdf"`,
          "Cache-Control": "no-store",
        },
      });
    }
    return NextResponse.json({ error: "format must be pdf, zpl, tspl or preview" }, { status: 400 });
  } catch (err) {
    return failure(err);
  }
}

export async function POST(request: NextRequest) {
  const auth = await authorize();
  if (auth.error) return auth.error;

  const body = (await request.json().catch(() => ({}))) as {
    batch?: unknown;
    serial?: unknown;
    delivery?: unknown;
    only?: unknown;
  };
  const target = targetFrom(body.batch, body.serial, body.delivery, body.only);
  if (!target) return NextResponse.json({ error: "Give a batch, a serial or a delivery" }, { status: 400 });
  if ("error" in target) return NextResponse.json({ error: target.error }, { status: 400 });

  try {
    const sent = await printLabels(target);
    return NextResponse.json({ ok: true, sent });
  } catch (err) {
    if (err instanceof DomainError) return failure(err);
    // Printer connection problems are worth showing: they carry the host and reason.
    const message = err instanceof Error ? err.message : "Printing failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
