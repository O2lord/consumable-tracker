// What each person sees on the dashboard: for each of three widgets, which items it counts and whether bulk
// quantities are shown in packs or in pieces. Kept in a cookie, so it needs no database change and is read on the
// server before the page draws.

/** Which kinds of item a widget counts: serialized bottles, bulk (quantity) items, or both. Worked out from the picked items. */
export type ItemScope = "bottles" | "bulk" | "both";

/** Bulk quantities shown as whole packs or as single pieces. Bottles are never counted in either. */
export type QuantityUnit = "pieces" | "packs";

export type WidgetKey = "locations" | "health" | "states";

/**
 * Which item types a widget shows. null means every item. Otherwise the cookie holds whichever list is shorter, the
 * items picked ("only") or the items left out ("except"), so it stays small when there are many item types.
 */
export type ItemFilter = { only: string[] } | { except: string[] } | null;

export interface WidgetPref {
  scope: ItemScope;
  unit: QuantityUnit;
  items: ItemFilter;
  /** Which locations the widget shows (same shape as items, by location id). Only the per-location and stock health widgets use it. */
  places: ItemFilter;
}

export type DashboardPrefs = Record<WidgetKey, WidgetPref>;

export const PREFS_COOKIE = "dashboard_prefs";

export const WIDGET_KEYS: readonly WidgetKey[] = ["locations", "health", "states"];
export const SCOPES: readonly ItemScope[] = ["bottles", "bulk", "both"];
export const UNITS: readonly QuantityUnit[] = ["pieces", "packs"];

export const DEFAULT_WIDGET_PREF: WidgetPref = { scope: "both", unit: "pieces", items: null, places: null };

export const DEFAULT_PREFS: DashboardPrefs = {
  locations: { ...DEFAULT_WIDGET_PREF },
  health: { ...DEFAULT_WIDGET_PREF },
  states: { ...DEFAULT_WIDGET_PREF },
};

const MAX_IDS = 500;

/** The most locations the per-location chart can show. More would make the card very long. */
export const MAX_LOCATIONS = 4;

function cleanIds(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const ids = value.filter((v): v is string => typeof v === "string" && v.length > 0 && v.length <= 64);
  return ids.slice(0, MAX_IDS);
}

function cleanFilter(value: unknown): ItemFilter {
  if (!value || typeof value !== "object") return null;
  const v = value as { only?: unknown; except?: unknown };
  const only = cleanIds(v.only);
  if (only) return { only };
  const except = cleanIds(v.except);
  if (except) return { except };
  return null;
}

/** Check one widget's saved choice, falling back to the default for anything missing or not understood. */
export function cleanWidgetPref(saved: Partial<WidgetPref> | null | undefined): WidgetPref {
  return {
    scope: saved?.scope && SCOPES.includes(saved.scope) ? saved.scope : DEFAULT_WIDGET_PREF.scope,
    unit: saved?.unit && UNITS.includes(saved.unit) ? saved.unit : DEFAULT_WIDGET_PREF.unit,
    items: cleanFilter(saved?.items),
    places: cleanFilter(saved?.places),
  };
}

/** Read the saved choices from the cookie value. */
export function parsePrefs(raw: string | null | undefined): DashboardPrefs {
  let data: Partial<Record<WidgetKey, Partial<WidgetPref>>> | null = null;
  try {
    data = raw ? (JSON.parse(raw) as Partial<Record<WidgetKey, Partial<WidgetPref>>>) : null;
  } catch {
    // A damaged cookie just means the defaults.
  }
  return {
    locations: cleanWidgetPref(data?.locations),
    health: cleanWidgetPref(data?.health),
    states: cleanWidgetPref(data?.states),
  };
}

export const usesBottles = (scope: ItemScope) => scope !== "bulk";
export const usesBulk = (scope: ItemScope) => scope !== "bottles";

/** Whether a widget with this filter shows the item type or location with that id. */
export function itemKept(filter: ItemFilter, id: string): boolean {
  if (!filter) return true;
  return "only" in filter ? filter.only.includes(id) : !filter.except.includes(id);
}

/** The word for what a widget counts, for its title. */
export function scopeNoun(scope: ItemScope): string {
  return scope === "bottles" ? "Bottles" : scope === "bulk" ? "Bulk items" : "Items";
}
