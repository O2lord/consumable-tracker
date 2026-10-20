"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/server/auth/session";
import { listActiveItemTypes, listActiveLocations } from "@/server/services/catalog.service";
import {
  MAX_LOCATIONS,
  PREFS_COOKIE,
  UNITS,
  WIDGET_KEYS,
  parsePrefs,
  type ItemFilter,
  type ItemScope,
  type QuantityUnit,
  type WidgetKey,
} from "@/lib/dashboard-prefs";

/** Keep whichever list is shorter, so the cookie stays small however many there are. */
function compactFilter(allIds: string[], pickedIds: Set<string>): ItemFilter {
  const chosen = allIds.filter((id) => pickedIds.has(id));
  if (chosen.length === allIds.length) return null;
  return chosen.length <= allIds.length / 2 ? { only: chosen } : { except: allIds.filter((id) => !pickedIds.has(id)) };
}

/**
 * Save one widget's setting: the items and locations it shows, and whether bulk quantities are in packs or pieces.
 * The other widgets are left as they were. The kinds of item counted (bottles, bulk or both) come from the items picked.
 * `places` is left out for a widget that is not split by location.
 */
export async function saveWidgetPrefAction(
  key: WidgetKey,
  input: { unit: QuantityUnit; selected: string[]; places?: string[] },
): Promise<{ ok: boolean; error?: string }> {
  await requirePermission("view_dashboard");
  if (!WIDGET_KEYS.includes(key) || !UNITS.includes(input.unit) || !Array.isArray(input.selected)) {
    return { ok: false, error: "That setting was not understood." };
  }

  const all = await listActiveItemTypes();
  const picked = new Set(input.selected.filter((id): id is string => typeof id === "string"));
  const chosen = all.filter((i) => picked.has(i.id));
  if (chosen.length === 0) return { ok: false, error: "Pick at least one item." };

  const bottles = chosen.some((i) => i.trackingMode === "SERIAL");
  const bulk = chosen.some((i) => i.trackingMode !== "SERIAL");
  const scope: ItemScope = bottles && bulk ? "both" : bottles ? "bottles" : "bulk";
  const items = compactFilter(
    all.map((i) => i.id),
    picked,
  );

  let places: ItemFilter = null;
  if (input.places) {
    const allPlaces = (await listActiveLocations()).map((l) => l.id);
    const pickedPlaces = new Set(input.places.filter((id): id is string => typeof id === "string"));
    if (!allPlaces.some((id) => pickedPlaces.has(id))) return { ok: false, error: "Pick at least one location." };
    if (key === "locations" && allPlaces.filter((id) => pickedPlaces.has(id)).length > MAX_LOCATIONS) {
      return { ok: false, error: `Pick no more than ${MAX_LOCATIONS} locations.` };
    }
    places =
      key === "locations"
        ? { only: allPlaces.filter((id) => pickedPlaces.has(id)) } // exactly the ones ticked, so a new location never joins
        : compactFilter(allPlaces, pickedPlaces);
  }

  const jar = await cookies();
  const prefs = parsePrefs(jar.get(PREFS_COOKIE)?.value);
  prefs[key] = { scope, unit: input.unit, items, places };
  jar.set(PREFS_COOKIE, JSON.stringify(prefs), {
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    sameSite: "lax",
    httpOnly: true,
  });
  revalidatePath("/dashboard");
  return { ok: true };
}
