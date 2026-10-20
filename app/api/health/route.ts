import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "../../../server/db/client";
import { appMeta } from "../../../server/db/schema";

export async function GET() {
  try {
    const rows = await db()
      .select({ value: appMeta.value })
      .from(appMeta)
      .where(eq(appMeta.key, "schema_version"))
      .limit(1);

    return NextResponse.json({
      ok: true,
      database: "reachable",
      schemaVersion: rows[0]?.value ?? null,
    });
  } catch (error) {
    // Log details server-side; never return connection info to the client.
    console.error("health check failed", error);
    return NextResponse.json({ ok: false, database: "unreachable" }, { status: 503 });
  }
}
