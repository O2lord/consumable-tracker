import { redirect } from "next/navigation";

/** Stock counts now live on the Stock page, in the "Stock count" tab. This keeps old links and bookmarks working. */
export default async function StockCountRedirect({ searchParams }: { searchParams: Promise<{ location?: string }> }) {
  const { location } = await searchParams;
  const query = new URLSearchParams({ tab: "count" });
  if (location) query.set("location", location);
  redirect(`/distribution/stock?${query.toString()}`);
}
