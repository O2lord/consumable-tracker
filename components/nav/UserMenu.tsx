"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useSyncState } from "@/offline/use-sync-state";

function initialsOf(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

// The signed-in person in the top bar: a status dot, their name and role, and a small avatar button
// that opens a menu with the profile and sign out. The dot is green online and amber offline.
// Sign out is a server action passed in from the layout, so this file stays free of server code.
export function UserMenu({
  name,
  roleName,
  logoutAction,
}: {
  name: string;
  roleName: string;
  logoutAction: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const { online } = useSyncState();
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Close on a click outside the menu or on Escape. Only listen while it is open.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const itemClass =
    "block w-full rounded-md px-3 py-2 text-left text-sm font-medium text-ink hover:bg-brand-soft focus:bg-brand-soft focus:outline-none";

  return (
    <div className="flex items-center gap-3">
      <div className="flex flex-col leading-tight">
        <span className="flex items-center gap-2">
          <span
            aria-hidden
            title={online ? "Online" : "Offline"}
            className={`inline-block h-2.5 w-2.5 rounded-full ${online ? "bg-green-600" : "bg-amber-500"}`}
          />
          <span className="text-sm font-semibold">{name}</span>
        </span>
        <span className="ml-[18px] text-xs font-normal text-muted">{roleName}</span>
      </div>
      <div ref={rootRef} className="relative">
        <button
          ref={buttonRef}
          type="button"
          aria-label="Account menu"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="flex items-center gap-1 rounded-full border border-line bg-surface py-1 pr-2.5 pl-1 hover:bg-brand-soft"
        >
          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-brand text-sm font-semibold text-white">
            {initialsOf(name)}
          </span>
          <svg
            aria-hidden="true"
            viewBox="0 0 20 20"
            className={`h-4 w-4 text-muted transition-transform ${open ? "rotate-180" : ""}`}
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M5 8l5 5 5-5" />
          </svg>
        </button>

        {open && (
          <div
            role="menu"
            className="absolute right-0 z-50 mt-2 w-52 rounded-xl border border-line bg-surface p-1.5 shadow-lg"
          >
            <Link href="/profile" role="menuitem" className={itemClass} onClick={() => setOpen(false)}>
              My profile
            </Link>
            <form action={logoutAction}>
              <button type="submit" role="menuitem" className={itemClass}>
                Sign out
              </button>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}
