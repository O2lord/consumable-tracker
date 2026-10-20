import { can, canWorkAtAnyLocation } from "@/server/auth/permissions";
import type { CodeLookup } from "@/server/services/lookup.service";
import type { UserRole } from "@/server/domain/types";

export interface Destination {
  href: string;
  label: string;
}

interface Viewer {
  role: UserRole;
  homeLocationId: string | null;
}

/**
 * Where a scanned label should take the person: the page that shows the thing where it is right now.
 * Only returns pages the person may open, so the link never lands on a 404 or an access error.
 * Returns null when there is nowhere useful to go.
 */
export function destinationFor(result: CodeLookup, viewer: Viewer): Destination | null {
  const { role, homeLocationId } = viewer;
  const anywhere = canWorkAtAnyLocation(role);
  const atHome = (locationId: string | null) => anywhere || (!!homeLocationId && homeLocationId === locationId);
  const enc = encodeURIComponent;

  switch (result.kind) {
    case "unit": {
      const { state, serial } = result;

      if (state === "ISSUED" && can(role, "issue") && atHome(result.locationId)) {
        return { href: `/distribution/issue/${enc(serial)}`, label: "Open issued bottle" };
      }

      if ((state === "IN_TRANSIT" || state === "MISSING_IN_TRANSIT") && result.transferCode) {
        if (can(role, "dispatch")) {
          return { href: `/store/transfers/${enc(result.transferCode)}`, label: "Open transfer" };
        }
        if (can(role, "receive") && atHome(result.transferToLocationId)) {
          return { href: `/distribution/receive/${enc(result.transferCode)}`, label: "Open transfer" };
        }
      }

      if (state === "IN_STOCK" || state === "RETURNED") {
        if (result.locationType === "STORE") {
          if (can(role, "stock_in")) {
            return { href: `/store/stock-in/${enc(result.batchCode)}`, label: "Open batch" };
          }
        } else if (can(role, "view_location_stock") && atHome(result.locationId)) {
          return {
            href: `/distribution/stock/${enc(result.itemCode)}?location=${enc(result.locationId)}`,
            label: "Open stock item",
          };
        }
      }

      // Any state, any location (voided, written off, or a page the person cannot open): the full history.
      if (can(role, "view_reports")) {
        return { href: `/reports/bottle/${enc(serial)}`, label: "Open bottle history" };
      }
      return null;
    }

    case "transfer": {
      if (can(role, "dispatch")) {
        return { href: `/store/transfers/${enc(result.code)}`, label: "Open transfer" };
      }
      if (can(role, "receive") && result.status !== "DRAFT" && atHome(result.toLocationId)) {
        return { href: `/distribution/receive/${enc(result.code)}`, label: "Open transfer" };
      }
      return null;
    }

    case "delivery":
      return can(role, "stock_in")
        ? { href: `/store/stock-in/delivery/${enc(result.code)}`, label: "Open delivery" }
        : null;

    case "pack":
      return can(role, "stock_in") ? { href: `/store/stock-in/${enc(result.batchCode)}`, label: "Open batch" } : null;

    case "batch":
      return can(role, "stock_in") ? { href: `/store/stock-in/${enc(result.code)}`, label: "Open batch" } : null;

    default:
      return null;
  }
}
