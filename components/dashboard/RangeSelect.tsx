"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { MAX_CUSTOM_DAYS, RANGE_OPTIONS, daysBetween, type CustomRange, type DashboardRange } from "@/lib/dashboard";
import { DatePicker } from "@/components/ui/DatePicker";
import { Dropdown } from "@/components/ui/Dropdown";

const CUSTOM = "custom";
const OPTIONS = [...RANGE_OPTIONS.map((d) => ({ value: String(d), label: `Last ${d} days` })), { value: CUSTOM, label: "Custom" }];

const pad = (n: number) => String(n).padStart(2, "0");
/** Today on the person's own clock, as YYYY-MM-DD: the latest day they can pick. */
function todayLocal() {
  const now = new Date();
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * The "Last 7 days" pill in the dashboard header, with a Custom choice that opens a start and end date.
 * The range lives in the URL (?range= or ?from=&to=) so the page re-fetches on the server.
 */
export function RangeSelect({ range, custom }: { range: DashboardRange; custom: CustomRange | null }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  // The date fields show while Custom is the chosen range, even before dates have been applied.
  const [editing, setEditing] = useState(custom !== null);
  const [from, setFrom] = useState(custom?.from ?? "");
  const [to, setTo] = useState(custom?.to ?? "");

  const go = (url: string) => startTransition(() => router.push(url, { scroll: false }));
  const today = todayLocal();

  const bothPicked = from !== "" && to !== "";
  const order = bothPicked && from > to ? "The start date must be on or before the end date." : null;
  const tooLong = bothPicked && !order && daysBetween(from, to).length > MAX_CUSTOM_DAYS ? `Pick at most ${MAX_CUSTOM_DAYS} days.` : null;
  const problem = order ?? tooLong;
  const unchanged = custom !== null && custom.from === from && custom.to === to;

  const apply = () => {
    if (!bothPicked || problem) return;
    go(`/dashboard?from=${from}&to=${to}`);
  };

  return (
    <div className={`flex flex-col items-end gap-1 ${pending ? "opacity-60 transition-opacity" : "transition-opacity"}`} aria-busy={pending}>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Dropdown
          ariaLabel="Date range"
          options={OPTIONS}
          value={editing || custom ? CUSTOM : String(range)}
          onChange={(value) => {
            if (value === CUSTOM) {
              setEditing(true);
              return;
            }
            setEditing(false);
            go(`/dashboard?range=${value}`);
          }}
        />
        {editing || custom ? (
          <>
            <DatePicker
              name="from"
              ariaLabel="Start date"
              placeholder="Start date"
              defaultValue={from}
              required
              max={to && to < today ? to : today}
              wrapperClassName="w-40"
              onChange={setFrom}
            />
            <span className="text-sm text-muted" aria-hidden>
              to
            </span>
            <DatePicker
              name="to"
              ariaLabel="End date"
              placeholder="End date"
              defaultValue={to}
              required
              alignRight
              {...(from ? { min: from } : {})}
              max={today}
              wrapperClassName="w-40"
              onChange={setTo}
            />
            <button
              type="button"
              onClick={apply}
              disabled={!bothPicked || problem !== null || unchanged || pending}
              className="rounded-lg bg-brand px-4 py-1.5 text-sm font-semibold text-brand-ink disabled:opacity-50"
            >
              Apply
            </button>
          </>
        ) : null}
      </div>
      {problem ? (
        <p role="alert" className="text-xs text-bad">
          {problem}
        </p>
      ) : null}
    </div>
  );
}
