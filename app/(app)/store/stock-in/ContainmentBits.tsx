import Link from "next/link";
import { SmartPrint } from "@/components/labels/SmartPrint";
import { linkButtonClass, monoChipClass } from "@/components/ui/styles";
import { Tag } from "@/components/ui/Tag";

// Small pieces shared by the pages that walk down a delivery: batch -> carton -> pack -> bottle.

/** "Back" link in the same style as the other store pages. */
export function BackLink({ href }: { href: string }) {
  return (
    <Link href={href} className="mb-4 flex w-fit items-center gap-1.5 text-sm font-semibold text-side-title hover:underline">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
        <path d="M10 3L5 8l5 5" />
      </svg>
      Back
    </Link>
  );
}

/** A small caption above a value, for the details panel of a page. */
export function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-xs font-semibold uppercase tracking-wide text-muted">{label}</div>
      <div className="mt-0.5 break-words text-[15px] font-medium text-ink">{children}</div>
    </div>
  );
}

const STATE_TEXT: Record<string, string> = {
  IN_STOCK: "In stock",
  IN_TRANSIT: "In transit",
  MISSING_IN_TRANSIT: "Missing in transit",
  ISSUED: "Issued",
  RETURNED: "Returned",
  VOIDED: "Voided",
  WRITTEN_OFF: "Written off",
};

export function stateText(state: string): string {
  return STATE_TEXT[state] ?? state;
}

/**
 * The actions at the end of a table row: print this one label on its own (any CN, PK or CT code), and, for a carton
 * or a pack, open the page of what is inside it.
 */
export function RowActions({ labelCode, open }: { labelCode: string; open?: string }) {
  return (
    <div className="flex items-center justify-end gap-3">
      <SmartPrint
        pdfHref={`/api/labels?serial=${encodeURIComponent(labelCode)}&format=pdf`}
        tsplHref={`/api/labels?serial=${encodeURIComponent(labelCode)}&format=tspl`}
        className="whitespace-nowrap text-sm font-semibold text-side-title underline"
      >
        Print label
      </SmartPrint>
      {open ? (
        <Link href={open} className={linkButtonClass}>
          Open
        </Link>
      ) : null}
    </div>
  );
}

/**
 * Bottle codes laid out eight to a row, with room between them. Each opens that bottle's history. A bottle that has
 * been transferred out is struck through and dimmed: it is no longer part of this pack's next print.
 */
export function BottleGrid({ bottles }: { bottles: { serial: string; transferred: boolean }[] }) {
  return (
    <div className="overflow-x-auto">
      <div className="grid min-w-[48rem] grid-cols-8 gap-3">
        {bottles.map(({ serial, transferred }) => (
          <Link
            key={serial}
            href={`/reports/bottle/${serial}`}
            title={transferred ? "Transferred out. Not included when labels are printed again." : undefined}
            className={`${monoChipClass} block px-3 py-2 text-center text-[13px] ${
              transferred ? "text-muted line-through opacity-60" : "underline"
            }`}
          >
            {serial}
          </Link>
        ))}
      </div>
    </div>
  );
}

/** Whether a pack's label has been printed. "Not printed" is the thing the store keeper is looking for. */
export function PrintedTag({ printedAt }: { printedAt: Date | null }) {
  if (!printedAt) return <Tag tone="warn">Not printed</Tag>;
  return <Tag tone="ok">Printed</Tag>;
}

/** "Showing the first 500 of 1,800." when a list was cut short. Renders nothing when everything is shown. */
export function ShowingNote({ shown, total, noun }: { shown: number; total: number; noun: string }) {
  if (total <= shown) return null;
  return (
    <p className="mt-3 text-sm text-muted">
      Showing the first {shown.toLocaleString("en-GB")} of {total.toLocaleString("en-GB")} {noun}.
    </p>
  );
}
