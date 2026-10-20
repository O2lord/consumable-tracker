// Shared Tailwind class strings, so forms look the same everywhere.
export const inputClass =
  "rounded-lg border border-line bg-page px-3 py-2 text-base font-normal text-ink focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/30";
export const buttonClass =
  "rounded-lg bg-brand px-4 py-2 font-semibold text-brand-ink hover:brightness-95 disabled:opacity-60";
export const ghostButtonClass =
  "rounded-lg border border-line bg-surface px-4 py-2 text-sm font-medium text-ink hover:bg-brand-soft";
export const dangerButtonClass =
  "rounded-lg bg-red-600 px-4 py-2 font-semibold text-white hover:bg-red-700 disabled:opacity-60";
export const compactDangerButtonClass =
  "rounded-lg bg-red-600 px-2 py-1 text-xs font-semibold text-white hover:bg-red-700 disabled:opacity-60";
export const cardClass = "rounded-xl border border-line bg-surface p-4";
// Page-level pieces shared by the store pages (stock in, dispatch, transfers).
export const pageTitleClass = "text-[26px] font-bold tracking-tight";
export const pageSubtitleClass = "mt-1 max-w-xl text-[15px] leading-relaxed text-zinc-500";
export const panelClass = "rounded-xl border border-line bg-surface p-5";
export const calloutClass = "rounded-lg bg-brand-soft px-4 py-3 text-sm text-ink";
export const warnCalloutClass = "rounded-lg bg-warn-soft px-4 py-3 text-sm text-warn";
export const monoChipClass = "rounded-md border border-line bg-page px-2 py-1 font-mono text-[13px]";
/** A link that looks like an outlined button. */
export const linkButtonClass =
  "inline-flex min-h-10 items-center rounded-lg border border-line bg-surface px-4 py-2 text-sm font-medium text-ink hover:bg-brand-soft";
/** A link that looks like the main (filled) button. */
export const primaryLinkButtonClass =
  "inline-flex min-h-10 items-center rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-brand-ink hover:brightness-95";
export const tableClass = "w-full border-collapse text-left text-sm";
export const thClass = "whitespace-nowrap border-b border-line px-2.5 py-2 text-[13px] font-semibold text-muted";
export const tdClass = "border-b border-line px-2.5 py-2.5 align-top tabular-nums";
/**
 * Segmented tab bar like the UATH staff portal: a soft tray, the chosen tab lifted as a white pill,
 * the others plain muted text. Used by every tab strip in the app (button tabs and link tabs).
 */
export const tabListClass = "flex w-full gap-1 overflow-x-auto rounded-xl bg-[var(--track)] p-1";
export const tabClass = (on: boolean) =>
  `shrink-0 whitespace-nowrap rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
    on ? "bg-surface font-semibold text-ink shadow-sm" : "text-muted hover:text-ink"
  }`;
