import { expect, test } from "@playwright/test";

test("health endpoint reports the database is reachable", async ({ request }) => {
  const res = await request.get("/api/health");
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.ok).toBe(true);
  expect(body.database).toBe("reachable");
});
