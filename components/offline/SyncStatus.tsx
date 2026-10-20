"use client";

import Link from "next/link";
import { useEffect } from "react";
import { setSessionUser, startAutoSync } from "@/offline/sync";
import { useSyncState } from "@/offline/use-sync-state";

/**
 * The offline indicator in the header, and where background sending is started for the page.
 * It says whether the device is online, how many scans are waiting to be sent, and links to the
 * needs-attention list when the server refused any.
 */
export function SyncStatus({ userId }: { userId: string }) {
  const sync = useSyncState();

  useEffect(() => {
    startAutoSync();
    setSessionUser(userId);
  }, [userId]);

  const { pending, held, rejected } = sync.summary;
  const mine = pending - held;

  return (
    <div className="flex flex-wrap items-center gap-3 text-sm" aria-live="polite">
      <span className="sr-only">{sync.online ? "Online" : "Offline"}</span>

      {mine > 0 ? (
        <span className="text-sky-700 dark:text-sky-300">
          {mine} scan{mine === 1 ? "" : "s"} {sync.syncing ? "sending..." : "waiting to send"}
        </span>
      ) : null}

      {held > 0 ? (
        <Link href="/needs-attention" className="text-amber-700 underline dark:text-amber-300">
          {held} waiting for another user
        </Link>
      ) : null}

      {sync.authRequired ? (
        <Link href="/login" className="text-red-600 underline">
          Sign in again to send
        </Link>
      ) : null}

      {rejected > 0 ? (
        <Link href="/needs-attention" className="font-medium text-red-600 underline">
          {rejected} need{rejected === 1 ? "s" : ""} attention
        </Link>
      ) : null}
    </div>
  );
}
