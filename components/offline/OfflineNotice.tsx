"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

/** Shown instead of a page when the server cannot reach Supabase. Retries when the browser is back online. */
export function OfflineNotice({ onRetry }: { onRetry?: () => void }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [tried, setTried] = useState(false);

  // Keep the latest callbacks in a ref so the online listener never goes stale.
  const retryRef = useRef<() => void>(() => {});
  retryRef.current = () => {
    setTried(true);
    startTransition(() => {
      router.refresh();
      onRetry?.();
    });
  };

  useEffect(() => {
    const onOnline = () => retryRef.current();
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, []);

  return (
    <div className="mx-auto mt-24 max-w-md space-y-3 p-6 text-center">
      <h1 className="text-lg font-semibold">Cannot reach the server</h1>
      <p className="text-sm opacity-80">
        Check your internet connection. This page will retry when you are back online, or you can try now.
      </p>
      <button
        type="button"
        disabled={pending}
        onClick={() => retryRef.current()}
        className="cursor-pointer rounded border px-4 py-2 text-sm font-medium hover:bg-black/5 disabled:cursor-wait disabled:opacity-60"
      >
        {pending ? "Retrying…" : "Try again"}
      </button>
      {tried && !pending ? <p className="text-sm text-red-700">Still cannot reach the server.</p> : null}
    </div>
  );
}
