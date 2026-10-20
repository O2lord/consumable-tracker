"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

type ToastKind = "success" | "error";

interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
}

interface ToastApi {
  success: (message: string) => void;
  error: (message: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

/**
 * Returns the toast controls, or null when there is no ToastProvider above (for example on the sign-in page),
 * so callers can fall back to showing the message in the page.
 */
export function useToast() {
  return useContext(ToastContext);
}

const MAX_VISIBLE = 4;

/** Wrap the app once. Toasts stack at the bottom right and disappear on their own. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(0);

  const dismiss = useCallback((id: number) => setItems((list) => list.filter((t) => t.id !== id)), []);

  const push = useCallback((kind: ToastKind, message: string) => {
    const id = ++nextId.current;
    setItems((list) => [...list.slice(-(MAX_VISIBLE - 1)), { id, kind, message }]);
  }, []);

  // The controls never change, so components that use them are not re-rendered or re-run when a toast appears.
  const api = useMemo<ToastApi>(
    () => ({ success: (m) => push("success", m), error: (m) => push("error", m) }),
    [push],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed right-4 bottom-4 z-[100] flex w-[min(24rem,calc(100%-2rem))] flex-col gap-2"
      >
        {items.map((item) => (
          <ToastCard key={item.id} item={item} onDismiss={dismiss} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastCard({ item, onDismiss }: { item: ToastItem; onDismiss: (id: number) => void }) {
  // Longer messages stay a little longer so they can be read.
  const duration = Math.min(10000, 4000 + item.message.length * 40);

  useEffect(() => {
    const timer = window.setTimeout(() => onDismiss(item.id), duration);
    return () => window.clearTimeout(timer);
  }, [item.id, duration, onDismiss]);

  const isError = item.kind === "error";

  return (
    <div
      role={isError ? "alert" : "status"}
      className={`pointer-events-auto flex items-start gap-3 rounded-xl border bg-surface px-4 py-3 text-sm shadow-lg ${
        isError ? "border-red-600" : "border-ok"
      }`}
    >
      <svg
        aria-hidden
        viewBox="0 0 20 20"
        className={`mt-0.5 h-4 w-4 shrink-0 ${isError ? "text-red-600" : "text-ok"}`}
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {isError ? <path d="M5 5l10 10M15 5L5 15" /> : <path d="M4 10.5l4 4 8-9" />}
      </svg>
      <p className="min-w-0 flex-1 break-words">{item.message}</p>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => onDismiss(item.id)}
        className="-mr-1 shrink-0 rounded px-1 text-muted hover:text-ink"
      >
        ×
      </button>
    </div>
  );
}
