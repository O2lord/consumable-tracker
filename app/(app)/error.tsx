"use client";

import { OfflineNotice } from "@/components/offline/OfflineNotice";

// Fallback for anything else that throws under (app), such as a database query failing mid-page.
// The offline case for the session check is handled in the layout without throwing.
export default function AppError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <OfflineNotice onRetry={reset} />;
}
