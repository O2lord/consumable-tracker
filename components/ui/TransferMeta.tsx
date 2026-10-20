import { TRANSFER_STATUS_LABEL } from "@/types/transfers";

// Soft background plus a darker text of the same family, so the status reads at a glance.
const STATUS_TONE: Record<string, string> = {
  DRAFT: "bg-warn-soft text-warn",
  DISPATCHED: "bg-brand-soft text-side-title",
  RECEIVING: "bg-brand-soft text-side-title",
  RECEIVED: "bg-ok-soft text-ok",
  RECEIVED_WITH_DISCREPANCY: "bg-warn-soft text-warn",
  DISCREPANCY_RESOLVED: "bg-ok-soft text-ok",
  CANCELLED: "bg-track text-muted",
};

const DONE_STATUSES = new Set(["RECEIVED", "DISCREPANCY_RESOLVED"]);

/**
 * A small coloured pill with the transfer status in plain words. `withIcon` adds a tick for finished
 * transfers; the transfer page uses it, the lists do not.
 */
export function TransferStatusPill({ status, withIcon = false }: { status: string; withIcon?: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ${
        STATUS_TONE[status] ?? "bg-track text-muted"
      }`}
    >
      {withIcon && DONE_STATUSES.has(status) ? (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <path d="M3 8.5l3 3 7-7" />
        </svg>
      ) : null}
      {TRANSFER_STATUS_LABEL[status] ?? status}
    </span>
  );
}

/**
 * "Main Lab → Fast Care Lab" as one unit. Screen readers hear "to" instead of the arrow.
 * `plain` draws a longer, green arrow, as on the draft transfer page.
 */
export function TransferRoute({ from, to, plain = false }: { from: string; to: string; plain?: boolean }) {
  return (
    <span className={`inline-flex flex-wrap items-center ${plain ? "gap-x-3" : "gap-x-2"} font-medium`}>
      <span>{from}</span>
      {plain ? (
        <svg
          width="44"
          height="10"
          viewBox="0 0 44 10"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          className="text-brand/60"
        >
          <path d="M1 5h41M38 1l4 4-4 4" />
        </svg>
      ) : (
        <svg
          width="18"
          height="10"
          viewBox="0 0 18 10"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          className="text-zinc-400"
        >
          <path d="M1 5h15M12 1l4 4-4 4" />
        </svg>
      )}
      <span className="sr-only">to</span>
      <span>{to}</span>
    </span>
  );
}
