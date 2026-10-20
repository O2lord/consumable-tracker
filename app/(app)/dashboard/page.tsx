import { cookies } from "next/headers";
import { requirePermission } from "@/server/auth/session";
import { can, worksAtOwnLocationOnly } from "@/server/auth/permissions";
import { countOpenDiscrepancies } from "@/server/services/discrepancy.service";
import { getDashboardInsights } from "@/server/services/dashboard.service";
import { getReportCounts } from "@/server/services/report.service";
import { listActiveItemTypes, listActiveLocations } from "@/server/services/catalog.service";
import { listTransfers } from "@/server/services/transfer.service";
import { customRangeLabel, parseCustomRange, parseRange } from "@/lib/dashboard";
import { PREFS_COOKIE, MAX_LOCATIONS, parsePrefs } from "@/lib/dashboard-prefs";
import { FlowChart } from "@/components/dashboard/FlowChart";
import { KpiCard } from "@/components/dashboard/KpiCard";
import { LocationBreakdown } from "@/components/dashboard/LocationBreakdown";
import { RangeSelect } from "@/components/dashboard/RangeSelect";
import { StateDonut } from "@/components/dashboard/StateDonut";
import { StockHealthCard } from "@/components/dashboard/StockHealthCard";
import { WidgetSettings, type ItemOption, type LocationOption } from "@/components/dashboard/WidgetSettings";

export const metadata = { title: "Dashboard" };

const percentLabel = (percent: number | null, text: string) => (percent === null ? null : { percent, label: `${percent}% ${text}` });

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string | string[]; from?: string | string[]; to?: string | string[] }>;
}) {
  const session = await requirePermission("view_dashboard");
  const query = await searchParams;
  const range = parseRange(query.range);
  // A custom range (?from=&to=) takes the place of the preset one when it is valid.
  const custom = parseCustomRange(query.from, query.to);
  const prefs = parsePrefs((await cookies()).get(PREFS_COOKIE)?.value);

  const showTransfers = can(session.role, "dispatch") || can(session.role, "receive") || can(session.role, "view_reports");
  const showDiscrepancies = can(session.role, "view_discrepancies");
  const showReports = can(session.role, "view_reports");

  const ownLocationOnly = worksAtOwnLocationOnly(session.role);

  const [openTransfers, discrepancies, reportCounts] = await Promise.all([
    showTransfers
      ? listTransfers({
          statuses: ["DISPATCHED", "RECEIVING"],
          // Distributors only see what is headed to their own location.
          toLocationId: ownLocationOnly ? (session.homeLocationId ?? undefined) : undefined,
          limit: 200,
        })
      : Promise.resolve([]),
    showDiscrepancies ? countOpenDiscrepancies() : Promise.resolve(0),
    showReports ? getReportCounts() : Promise.resolve(null),
  ]);
  // A distributor with no home location must see nothing rather than everything.
  const transfers = ownLocationOnly && !session.homeLocationId ? [] : openTransfers;

  // The charts span every location, so they are for people who can see reports.
  const insights = reportCounts
    ? await getDashboardInsights({
        days: range,
        ...(custom ? { custom } : {}),
        outstanding: reportCounts.outstanding,
        scopes: { states: prefs.states.scope, locations: prefs.locations.scope, health: prefs.health.scope },
        units: { states: prefs.states.unit, locations: prefs.locations.unit, health: prefs.health.unit },
        items: { states: prefs.states.items, locations: prefs.locations.items, health: prefs.health.items },
        places: { locations: prefs.locations.places, health: prefs.health.places },
      })
    : null;

  // What each widget's settings pop-up offers to tick: bottles first, then bulk items.
  const itemOptions: ItemOption[] = reportCounts
    ? (await listActiveItemTypes()).map((i) => ({ id: i.id, name: i.name, kind: i.trackingMode === "SERIAL" ? ("bottle" as const) : ("bulk" as const) }))
    : [];
  const locationOptions: LocationOption[] = reportCounts ? (await listActiveLocations()).map((l) => ({ id: l.id, name: l.name })) : [];

  const onItsWay = transfers.filter((t) => t.status === "DISPATCHED").length;
  const beingReceived = transfers.filter((t) => t.status === "RECEIVING").length;

  return (
    <div className="flex max-w-6xl flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-[22px] font-bold tracking-tight">Dashboard</h1>
          <p className="mt-1 text-sm text-muted">
            Signed in as {session.name} ({session.staffId}).
          </p>
        </div>
        {insights ? (
          <div className="flex flex-wrap items-start justify-end gap-2">
            <RangeSelect range={range} custom={custom} />
          </div>
        ) : null}
      </div>

      {/* gap-y-0: the cards' own bottom margin spaces wrapped rows, so the shared rows inside each card stay tight. */}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(145px,1fr))] gap-x-3 gap-y-0">
        {showTransfers ? (
          <KpiCard
            title="Open transfers"
            value={transfers.length}
            hint={`${onItsWay} on their way, ${beingReceived} being received`}
            progress={percentLabel(insights?.transferReceivedPercent ?? null, "received")}
            {...(can(session.role, "dispatch")
              ? { href: "/store/transfers", linkLabel: "All transfers" }
              : can(session.role, "receive")
                ? { href: "/distribution/receive", linkLabel: "Receive" }
                : {})}
          />
        ) : null}

        {showDiscrepancies ? (
          <KpiCard
            title="Open discrepancies"
            value={discrepancies}
            tone={discrepancies > 0 ? "bad" : "ok"}
            hint={discrepancies > 0 ? "Items sent but not received, still unresolved" : "Nothing outstanding"}
            progress={percentLabel(insights?.discrepancyResolvedPercent ?? null, "resolved")}
            href="/reports/discrepancies"
            linkLabel={discrepancies > 0 ? "See the exact serials" : "Open the report"}
          />
        ) : null}

        {reportCounts ? (
          <>
            <KpiCard
              title="Outstanding bottles"
              value={reportCounts.outstanding}
              tone={reportCounts.outstanding > 0 ? "warn" : "ok"}
              hint="Issued and not returned past the time limit"
              progress={percentLabel(insights?.outstandingOfIssuedPercent ?? null, "of issued")}
              href="/reports/outstanding"
              linkLabel="Open the report"
            />
            <KpiCard
              title="Exceptions"
              value={reportCounts.unverified + reportCounts.overrides + reportCounts.mismatches}
              tone={reportCounts.mismatches > 0 ? "bad" : null}
              hint={`${reportCounts.unverified} unverified payments, ${reportCounts.overrides} overrides, ${reportCounts.mismatches} not backed by the ledger`}
              progress={percentLabel(insights?.unverifiedClearedPercent ?? null, "of unverified payments cleared")}
              href="/reports/exceptions"
              linkLabel="Open the report"
            />
          </>
        ) : null}
      </div>

      {insights ? (
        <>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(280px,1fr))] gap-3">
            <FlowChart flow={insights.flow} range={insights.range} {...(custom ? { period: customRangeLabel(custom) } : {})} />
            <StateDonut
              states={insights.states}
              scope={prefs.states.scope}
              settings={<WidgetSettings widget="states" title="Items by state" initial={prefs.states} options={itemOptions} />}
            />
          </div>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(280px,1fr))] gap-3">
            <LocationBreakdown
              rows={insights.byLocation}
              locationNames={insights.locationNames}
              scope={prefs.locations.scope}
              settings={<WidgetSettings widget="locations" title="Items per location" initial={prefs.locations} options={itemOptions} locations={locationOptions} maxLocations={MAX_LOCATIONS} defaultPlaceIds={insights.locationIds} />}
            />
            <StockHealthCard
              health={insights.health}
              scope={prefs.health.scope}
              unit={prefs.health.unit}
              settings={<WidgetSettings widget="health" title="Stock health" initial={prefs.health} options={itemOptions} locations={locationOptions} dark />}
            />
          </div>
        </>
      ) : null}
    </div>
  );
}
