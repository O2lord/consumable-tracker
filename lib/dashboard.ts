// Pure helpers for the dashboard. No I/O and no framework imports, so they are easy to unit-test.

export const RANGE_OPTIONS = [7, 14, 30] as const;
export type DashboardRange = (typeof RANGE_OPTIONS)[number];
export const DEFAULT_RANGE: DashboardRange = 7;

/** Reads ?range= from the URL. Anything unexpected falls back to the default. */
export function parseRange(value: string | string[] | undefined): DashboardRange {
  const raw = Array.isArray(value) ? value[0] : value;
  const n = Number(raw);
  return (RANGE_OPTIONS as readonly number[]).includes(n) ? (n as DashboardRange) : DEFAULT_RANGE;
}

/** The longest custom range the dashboard will chart, in days. */
export const MAX_CUSTOM_DAYS = 366;

/** A custom range: first and last day (inclusive) as YYYY-MM-DD. */
export interface CustomRange {
  from: string;
  to: string;
}

const DAY_MS = 86_400_000;

/** True for a real calendar date written as YYYY-MM-DD (so 2026-02-31 is not). */
function isRealDay(value: string | undefined): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** Every calendar day from `from` to `to` inclusive, oldest first, as YYYY-MM-DD. */
export function daysBetween(from: string, to: string): string[] {
  const start = Date.parse(`${from}T00:00:00.000Z`);
  const count = Math.round((Date.parse(`${to}T00:00:00.000Z`) - start) / DAY_MS) + 1;
  return Array.from({ length: Math.max(0, count) }, (_, i) => isoDay(new Date(start + i * DAY_MS)));
}

/**
 * Reads ?from= and ?to= from the URL. Returns null (so the preset range is used) unless both are real dates, the
 * start is not after the end, and the span is within MAX_CUSTOM_DAYS. An end date in the future is pulled back to
 * tomorrow (UTC), which still lets someone ahead of UTC pick their own "today".
 */
export function parseCustomRange(
  from: string | string[] | undefined,
  to: string | string[] | undefined,
  now: Date = new Date(),
): CustomRange | null {
  const f = Array.isArray(from) ? from[0] : from;
  const t = Array.isArray(to) ? to[0] : to;
  if (!isRealDay(f) || !isRealDay(t)) return null;
  const limit = isoDay(new Date(now.getTime() + DAY_MS));
  const end = t > limit ? limit : t;
  if (f > end) return null;
  if (daysBetween(f, end).length > MAX_CUSTOM_DAYS) return null;
  return { from: f, to: end };
}

/** The share of `part` in `whole` as a whole percent (0 to 100), or null when there is nothing to measure. */
export function percentOf(part: number, whole: number): number | null {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) return null;
  return Math.min(100, Math.max(0, Math.round((part / whole) * 100)));
}

/**
 * How full an item is, on a scale where the reorder level sits at 50%. So 50% means "at the reorder
 * level", under 50% means "reorder now" and 100% means "twice the reorder level or more".
 * Items with no reorder level have no health and return null.
 */
export function stockLevelPercent(onHand: number, reorderLevel: number): number | null {
  if (reorderLevel <= 0) return null;
  return Math.min(100, Math.max(0, Math.round((onHand / (reorderLevel * 2)) * 100)));
}

export type LevelTone = "bad" | "warn" | "ok";

/** bad = below the reorder level, warn = within a quarter of the scale above it, ok = comfortable. */
export function levelTone(percent: number): LevelTone {
  return percent < 50 ? "bad" : percent < 75 ? "warn" : "ok";
}

/** A calendar date as YYYY-MM-DD in UTC (the same day convention the reports use). */
export function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** The last `days` calendar days ending at `end` (inclusive), oldest first, as YYYY-MM-DD. */
export function lastDays(days: number, end: Date = new Date()): string[] {
  const out: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate() - i));
    out.push(isoDay(d));
  }
  return out;
}

export interface DayFlow {
  day: string;
  issued: number;
  returned: number;
}

/** Puts a zero on every day that had no events, so the chart has no gaps. */
export function fillDays(days: readonly string[], rows: readonly DayFlow[]): DayFlow[] {
  const byDay = new Map(rows.map((r) => [r.day, r]));
  return days.map((day) => byDay.get(day) ?? { day, issued: 0, returned: 0 });
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** A day as "12 Oct 2026". */
export function formatDay(day: string): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  return `${d.getUTCDate()} ${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** A custom range as "12 Oct 2026 to 16 Oct 2026", or just the one day when it is a single day. */
export function customRangeLabel(range: CustomRange): string {
  return range.from === range.to ? formatDay(range.from) : `${formatDay(range.from)} to ${formatDay(range.to)}`;
}

/** Axis label for a day: the weekday for a week, day/month for longer ranges. */
export function dayLabel(day: string, range: number): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  return range <= 7 ? WEEKDAYS[d.getUTCDay()] : `${d.getUTCDate()}/${d.getUTCMonth() + 1}`;
}
