"use client";

import { dismissEvent } from "@/offline/sync";
import { useSyncState } from "@/offline/use-sync-state";
import { tableClass, tdClass, thClass } from "@/components/ui/styles";

/** Scans saved on this device that the server refused, or that are waiting for someone else to sign in. */
export function NeedsAttentionList() {
  const sync = useSyncState();
  const rejected = sync.events.filter((e) => e.status === "REJECTED");
  const held = sync.events.filter((e) => e.status === "PENDING" && sync.sessionUserId && e.userId !== sync.sessionUserId);

  return (
    <div className="flex flex-col gap-8">
      <section className="overflow-x-auto rounded-xl border border-line bg-surface px-2 py-1">
        <h2 className="mb-1 font-medium">Refused by the server ({rejected.length})</h2>
        <p className="mb-2 max-w-3xl text-sm text-zinc-500">
          These were scanned while offline and, when sent, were no longer valid: for example the receipt had been
          closed, or the bottle belongs to another transfer. Nothing was changed for them. Check the bottle itself,
          tell a supervisor if it matters, then dismiss the line.
        </p>
        <table className={tableClass}>
          <thead>
            <tr>
              <th className={thClass}>Scanned</th>
              <th className={thClass}>Bottle</th>
              <th className={thClass}>Slip</th>
              <th className={thClass}>Why it was refused</th>
              <th className={thClass} />
            </tr>
          </thead>
          <tbody>
            {rejected.map((e) => (
              <tr key={e.id}>
                <td className={tdClass}>{new Date(e.occurredAt).toLocaleString("en-GB")}</td>
                <td className={`${tdClass} font-mono`}>{e.serial}</td>
                <td className={`${tdClass} font-mono`}>{e.transferCode}</td>
                <td className={tdClass}>{e.message ?? "Refused"}</td>
                <td className={tdClass}>
                  <button
                    type="button"
                    onClick={() => void dismissEvent(e.id)}
                    className="rounded-lg border border-line bg-surface px-3 py-1 text-sm font-medium hover:bg-brand-soft"
                  >
                    Dismiss
                  </button>
                </td>
              </tr>
            ))}
            {rejected.length === 0 ? (
              <tr>
                <td className={tdClass} colSpan={5}>
                  Nothing needs attention.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </section>

      {held.length > 0 ? (
        <section className="overflow-x-auto rounded-xl border border-line bg-surface px-2 py-1">
          <h2 className="mb-1 font-medium">Waiting for another user ({held.length})</h2>
          <p className="mb-2 max-w-3xl text-sm text-zinc-500">
            These were scanned under a different sign-in on this device. They are only sent when that person signs in,
            so every scan stays under the right name.
          </p>
          <table className={tableClass}>
            <thead>
              <tr>
                <th className={thClass}>Scanned</th>
                <th className={thClass}>Bottle</th>
                <th className={thClass}>Slip</th>
              </tr>
            </thead>
            <tbody>
              {held.map((e) => (
                <tr key={e.id}>
                  <td className={tdClass}>{new Date(e.occurredAt).toLocaleString("en-GB")}</td>
                  <td className={`${tdClass} font-mono`}>{e.serial}</td>
                  <td className={`${tdClass} font-mono`}>{e.transferCode}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}
    </div>
  );
}
