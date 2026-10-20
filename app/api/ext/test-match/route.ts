import { NextResponse } from "next/server";
import { apiFailure, guard } from "@/server/auth/api-guard";
import { matchPortalTest, standardItemsForTest } from "@/server/services/extension.service";
import { acceptedContainers } from "@/lib/containers";

// GET /api/ext/test-match?name=<item name on the portal page> -> the catalog test and the container it
// needs, so the panel can say "needs an EDTA bottle" before anything is scanned.
// A test that is not in the catalog comes back with match: null.

export async function GET(request: Request) {
  const auth = await guard("issue");
  if (auth.error) return auth.error;
  const name = new URL(request.url).searchParams.get("name")?.trim();
  if (!name) return NextResponse.json({ error: "Missing test name" }, { status: 400 });
  try {
    const test = await matchPortalTest(name);
    // The bulk items one run of the test uses, so the panel can show them next to the bottle.
    const standard = test ? await standardItemsForTest(test.code) : { items: [], confirmed: false };
    return NextResponse.json({
      match: test
        ? {
            code: test.code,
            name: test.name,
            requiredContainer: test.requiredContainer,
            // Every container the test accepts (required first); empty means any container.
            acceptedContainers: acceptedContainers(test.requiredContainer, test.alternateContainers),
            standardItems: standard.items,
            standardItemsConfirmed: standard.confirmed,
          }
        : null,
    });
  } catch (err) {
    return apiFailure(err);
  }
}
