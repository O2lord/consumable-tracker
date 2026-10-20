import { PageLoading } from "@/components/ui/PageLoading";

// Shown while a page under (app) waits on the session check or its own data. Giving the segment its
// own Suspense boundary lets Next prerender the frame (sidebar, top bar) and navigate instantly.
export default function Loading() {
  return <PageLoading />;
}
