"use client";

import { useEffect, useRef } from "react";

/**
 * A message that floats over an open pop-up. The page's own toasts sit underneath a pop-up (a modal dialog
 * covers everything else), so a pop-up that wants to toast renders this inside itself. It looks like the page toast,
 * disappears on its own (longer messages stay a little longer) and can be dismissed. Give it a new `key` for each
 * message so the timer starts again. Red by default; `tone="ok"` is green, for a save that leaves the pop-up open.
 */
export function DialogToast({
  message,
  onDismiss,
  tone = "error",
}: {
  message: string;
  onDismiss: () => void;
  tone?: "error" | "ok";
}) {
  const duration = Math.min(10000, 4000 + message.length * 40);
  const dismissRef = useRef(onDismiss);
  useEffect(() => {
    dismissRef.current = onDismiss;
  });

  useEffect(() => {
    const timer = window.setTimeout(() => dismissRef.current(), duration);
    return () => window.clearTimeout(timer);
  }, [duration]);

  return (
    <div
      role={tone === "ok" ? "status" : "alert"}
      className={`fixed right-4 bottom-4 z-[300] flex w-[min(24rem,calc(100%-2rem))] items-start gap-3 rounded-xl border bg-surface px-4 py-3 text-sm shadow-lg ${
        tone === "ok" ? "border-ok" : "border-red-600"
      }`}
    >
      <svg
        aria-hidden
        viewBox="0 0 20 20"
        className={`mt-0.5 h-4 w-4 shrink-0 ${tone === "ok" ? "text-ok" : "text-red-600"}`}
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d={tone === "ok" ? "M4 10.5l4 4 8-9" : "M5 5l10 10M15 5L5 15"} />
      </svg>
      <p className="min-w-0 flex-1 break-words">{message}</p>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={onDismiss}
        className="-mr-1 shrink-0 rounded px-1 text-muted hover:text-ink"
      >
        ×
      </button>
    </div>
  );
}
