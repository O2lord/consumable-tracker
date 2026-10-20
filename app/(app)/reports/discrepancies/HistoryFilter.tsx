"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { DatePicker } from "@/components/ui/DatePicker";
import { Select, useClickOutside } from "@/components/ui/Dropdown";

interface Props {
  filters: { outcome?: "FOUND" | "WRITTEN_OFF"; from?: string; to?: string };
}

function FilterIcon() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 20 20"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 4.5h14l-5.5 6.5v4.5l-3 1.5V11L3 4.5z" />
    </svg>
  );
}

/**
 * A filter icon that opens a small pop-up with the outcome and date fields. Applying sends them as plain
 * query fields, so the page stays server-rendered and the filtered view can be bookmarked or shared.
 */
export function HistoryFilter({ filters }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const ref = useClickOutside(open, () => setOpen(false));
  const active = Boolean(filters.outcome || filters.from || filters.to);
  // New defaults after Apply or Clear: remount the fields so they show what is now applied.
  const formKey = `${filters.outcome ?? ""}|${filters.from ?? ""}|${filters.to ?? ""}`;

  // Not a native form submit: closing the pop-up would remove the form before the browser sent it.
  function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const params = new URLSearchParams({ tab: "history" });
    for (const key of ["outcome", "from", "to"]) {
      const value = String(data.get(key) ?? "");
      if (value) params.set(key, value);
    }
    setOpen(false);
    router.push(`/reports/discrepancies?${params.toString()}`);
  }

  return (
    <div
      ref={ref}
      className="relative"
      onKeyDown={(event) => {
        // A dropdown or calendar inside closes on its own Escape first; this closes the pop-up itself.
        if (event.key === "Escape" && open && !event.defaultPrevented) setOpen(false);
      }}
    >
      <button
        type="button"
        aria-label="Filter history"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="relative -mt-0.5 flex h-6 w-6 items-center justify-center rounded-md text-muted hover:bg-brand-soft hover:text-ink"
      >
        <FilterIcon />
        {active ? <span aria-hidden className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-brand" /> : null}
      </button>

      {open ? (
        <div
          role="dialog"
          aria-label="Filter history"
          className="absolute left-0 top-full z-30 mt-3 w-72 rounded-xl border border-line bg-surface p-4 shadow-lg"
        >
          <form key={formKey} onSubmit={apply} className="flex flex-col gap-3">
            <div className="flex flex-col gap-1 text-sm font-medium">
              <span>Outcome</span>
              <Select
                name="outcome"
                ariaLabel="Outcome"
                emptyLabel="All outcomes"
                defaultValue={filters.outcome ?? ""}
                options={[
                  { value: "FOUND", label: "Found" },
                  { value: "WRITTEN_OFF", label: "Written off" },
                ]}
              />
            </div>
            <div className="flex flex-col gap-1 text-sm font-medium">
              <span>From</span>
              <DatePicker
                name="from"
                defaultValue={filters.from ?? ""}
                ariaLabel="From date"
                placeholder="Any date"
                wrapperClassName="w-full"
              />
            </div>
            <div className="flex flex-col gap-1 text-sm font-medium">
              <span>To</span>
              <DatePicker
                name="to"
                defaultValue={filters.to ?? ""}
                ariaLabel="To date"
                placeholder="Any date"
                wrapperClassName="w-full"
              />
            </div>
            <div className="flex items-center justify-between pt-1">
              <Link href="/reports/discrepancies?tab=history" onClick={() => setOpen(false)} className="text-sm underline">
                Clear
              </Link>
              <button type="submit" className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-brand-ink">
                Apply
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </div>
  );
}
