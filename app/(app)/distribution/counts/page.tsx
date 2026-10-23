import { redirect } from "next/navigation";

/**
 * Stock counts now live on the Stock page, in the "Stock count" tab. This keeps old links and bookmarks working.
 * Where the person is working comes from the app bar, so an old ?location= in a bookmark is ignored.
 */
export default function StockCountRedirect() {
  redirect("/distribution/stock?tab=count");
}
