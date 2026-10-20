import { requirePermission } from "@/server/auth/session";
import {
  getPharmacyImportStats,
  listReconcileRunsPage,
  listStockMismatches,
  listTransferChecks,
  type StockProblem,
  type TransferProblem,
} from "@/server/services/pharmacy-reconcile.service";
import { ActionForm } from "@/components/forms/ActionForm";
import { tableClass, tdClass, thClass } from "@/components/ui/styles";
import { StatCard } from "@/components/ui/StatCard";
import { Tabs } from "@/components/ui/Tabs";
import { Tag, type Tone } from "@/components/ui/Tag";
import { Pagination } from "@/components/ui/Pagination";
import { pageOfArray, parsePage } from "@/lib/pagination";
import { runReconcileAction } from "./actions";

export const metadata = { title: "Pharmacy mismatch" };

const STOCK_LABEL: Record<StockProblem, string> = {
  QUANTITY_DIFFERS: "Different quantity",
  NOT_IN_TRACKER: "In Pharmacy, not in tracker",
  NOT_IN_PHARMACY: "In tracker, not in Pharmacy",
};

const TRANSFER_LABEL: Record<TransferProblem, string> = {
  QUANTITY_DIFFERS: "Different total",
  NO_PHARMACY_TRANSFER: "No Pharmacy transfer found",
  NO_TRACKER_TRANSFER: "No tracker transfer found",
  UNMAPPED_LOCATION: "Location not mapped",
  OK: "Agrees",
};

const STOCK_TONE: Record<StockProblem, Tone> = {
  QUANTITY_DIFFERS: "warn",
  NOT_IN_TRACKER: "bad",
  NOT_IN_PHARMACY: "brand",
};

const TRANSFER_TONE: Record<TransferProblem, Tone> = {
  QUANTITY_DIFFERS: "warn",
  NO_PHARMACY_TRANSFER: "bad",
  NO_TRACKER_TRANSFER: "bad",
  UNMAPPED_LOCATION: "warn",
  OK: "ok",
};

const when = (d: Date | null) => (d ? d.toLocaleString("en-GB") : "-");
const signed = (n: number | null) => (n === null ? "-" : n > 0 ? `+${n}` : String(n));

export default async function PharmacyMismatchPage({
  searchParams,
}: {
  searchParams: Promise<{ hpage?: string; spage?: string; tpage?: string }>;
}) {
  await requirePermission("view_reports");
  const sp = await searchParams;
  const [stats, stock, transfers, runPage] = await Promise.all([
    getPharmacyImportStats(),
    listStockMismatches(),
    listTransferChecks(),
    listReconcileRunsPage(parsePage(sp.hpage)),
  ]);
  const runs = runPage.rows;
  const stockPage = pageOfArray(stock, parsePage(sp.spage));
  const transferPage = pageOfArray(transfers, parsePage(sp.tpage));
  const keep = { hpage: sp.hpage, spage: sp.spage, tpage: sp.tpage };

  const noInventory = stats.inventory.rows === 0;
  const noTransfers = stats.transfers.rows === 0;
  const lastExport = stats.inventory.lastImportedAt;
  const daysSinceExport = lastExport ? Math.floor((new Date().getTime() - lastExport.getTime()) / 86_400_000) : null;

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-[22px] font-bold tracking-tight">Pharmacy mismatch</h1>
        <p className="mt-1 max-w-3xl text-sm text-zinc-500">
          The tracker checked against the Pharmacy exports loaded under Imports. Both checks compare with a snapshot, so
          a difference can also mean the export is older than the latest movement here: upload a fresh export and look
          again before acting. Differences are tracker minus Pharmacy.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard value={stock.length + transfers.length} label="differences" tone={stock.length + transfers.length > 0 ? "warn" : "ok"} />
        <StatCard value={stock.length} label="stock" />
        <StatCard value={transfers.length} label="transfers" />
        <StatCard
          value={daysSinceExport === null ? "None" : daysSinceExport === 1 ? "1 day" : `${daysSinceExport} days`}
          label="since last stock export"
          tone={daysSinceExport === null || daysSinceExport > 1 ? "bad" : "ok"}
        />
      </div>

      <Tabs
        label="Pharmacy checks"
        initialId={sp.tpage && !sp.hpage && !sp.spage ? "transfers" : sp.spage && !sp.hpage ? "stock" : "history"}
        tabs={[
          {
            id: "history",
            label: "Check history",
            content: (
      <section className="flex flex-col gap-3">
        <p className="max-w-3xl text-sm text-zinc-500">
          Each check counts the differences below and records them, so you can see whether they are growing. Nothing is
          blocked because of them. A daily check can call <span className="font-mono">POST /api/pharmacy/sync</span>.
        </p>
        <ActionForm action={runReconcileAction} submitLabel="Run check now" compact resetOnSuccess={false}>
          <input type="hidden" name="run" value="1" />
        </ActionForm>
        <div className="overflow-x-auto rounded-xl border border-line bg-surface px-2 py-1">
          <table className={tableClass}>
            <thead>
              <tr>
                <th className={thClass}>When</th>
                <th className={thClass}>Started by</th>
                <th className={thClass}>Differences</th>
                <th className={thClass}>Change</th>
                <th className={thClass}>Stock</th>
                <th className={thClass}>Transfers</th>
                <th className={thClass}>Inventory export</th>
                <th className={thClass}>Transfers export</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id}>
                  <td className={tdClass}>{when(r.startedAt)}</td>
                  <td className={tdClass}>{r.triggeredBy === "JOB" ? "Daily job" : "A person"}</td>
                  <td className={`${tdClass} font-mono`}>{r.problemsTotal}</td>
                  <td className={`${tdClass} font-mono`}>{signed(r.change)}</td>
                  <td className={`${tdClass} font-mono`}>{Object.values(r.summary.stock).reduce((a, b) => a + b, 0)}</td>
                  <td className={`${tdClass} font-mono`}>{Object.values(r.summary.transfers).reduce((a, b) => a + b, 0)}</td>
                  <td className={tdClass}>{when(r.inventoryImportedAt)}</td>
                  <td className={tdClass}>{when(r.transfersImportedAt)}</td>
                </tr>
              ))}
              {runs.length === 0 ? (
                <tr>
                  <td className={tdClass} colSpan={8}>
                    No check has been run yet.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
          <Pagination info={runPage} pathname="/reports/pharmacy" params={{ spage: keep.spage, tpage: keep.tpage }} param="hpage" noun="checks" />
        </div>
      </section>
            ),
          },
          {
            id: "stock",
            label: "Stock per location and batch",
            count: stock.length,
            content: (
      <section className="flex flex-col gap-3">
        <p className="max-w-3xl text-sm">
          {noInventory
            ? "No inventory export has been imported yet, so this check proves nothing."
            : `Checked against ${stats.inventory.rows} Pharmacy stock rows for ${stats.inventory.locations} location${stats.inventory.locations === 1 ? "" : "s"}, last import ${when(stats.inventory.lastImportedAt)}. Locations with no inventory import are not checked. Batches are matched on the batch number, so tracker batches without a lot number are left out.`}
        </p>
        <div className="overflow-x-auto rounded-xl border border-line bg-surface px-2 py-1">
          <table className={tableClass}>
            <thead>
              <tr>
                <th className={thClass}>Problem</th>
                <th className={thClass}>Location</th>
                <th className={thClass}>Batch</th>
                <th className={thClass}>Pharmacy item</th>
                <th className={thClass}>Tracker item</th>
                <th className={thClass}>Pharmacy</th>
                <th className={thClass}>Tracker</th>
                <th className={thClass}>Difference</th>
                <th className={thClass}>Pharmacy as of</th>
              </tr>
            </thead>
            <tbody>
              {stockPage.rows.map((r) => (
                <tr key={`${r.locationId}-${r.batchNo}-${r.problem}`}>
                  <td className={tdClass}>
                    <Tag tone={STOCK_TONE[r.problem]}>{STOCK_LABEL[r.problem]}</Tag>
                  </td>
                  <td className={tdClass}>{r.locationName}</td>
                  <td className={`${tdClass} font-mono`}>{r.batchNo ?? "-"}</td>
                  <td className={tdClass}>{r.pharmacyItem ?? "-"}</td>
                  <td className={tdClass}>{r.trackerItem ?? "-"}</td>
                  <td className={tdClass}>{r.pharmacyQuantity ?? "-"}</td>
                  <td className={tdClass}>{r.trackerQuantity ?? "-"}</td>
                  <td className={`${tdClass} font-mono`}>{signed(r.difference)}</td>
                  <td className={tdClass}>{when(r.pharmacyImportedAt)}</td>
                </tr>
              ))}
              {stock.length === 0 ? (
                <tr>
                  <td className={tdClass} colSpan={9}>
                    {noInventory ? "Nothing to show." : "Tracker stock matches the Pharmacy inventory for every batch checked."}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
          <Pagination info={stockPage} pathname="/reports/pharmacy" params={{ hpage: keep.hpage, tpage: keep.tpage }} param="spage" noun="differences" />
        </div>
      </section>
            ),
          },
          {
            id: "transfers",
            label: "Transfer totals",
            count: transfers.length,
            content: (
      <section className="flex flex-col gap-3">
        <p className="max-w-3xl text-sm">
          {noTransfers
            ? "No Pharmacy transfers have been imported yet, so every dispatched tracker transfer shows as having no Pharmacy transfer."
            : `Checked against ${stats.transfers.rows} Pharmacy transfers, last import ${when(stats.transfers.lastImportedAt)}. A transfer is paired by the Pharmacy transfer number typed at dispatch, or else by the same from and to locations and a request time within a day of the dispatch. Transfers that agree are not listed.`}
        </p>
        <div className="overflow-x-auto rounded-xl border border-line bg-surface px-2 py-1">
          <table className={tableClass}>
            <thead>
              <tr>
                <th className={thClass}>Problem</th>
                <th className={thClass}>Tracker transfer</th>
                <th className={thClass}>From</th>
                <th className={thClass}>To</th>
                <th className={thClass}>Dispatched</th>
                <th className={thClass}>Pharmacy transfer</th>
                <th className={thClass}>Requested</th>
                <th className={thClass}>Tracker</th>
                <th className={thClass}>Pharmacy</th>
                <th className={thClass}>Difference</th>
              </tr>
            </thead>
            <tbody>
              {transferPage.rows.map((r, i) => (
                <tr key={`${r.trackerCode ?? r.pharmacyRef ?? "p"}-${r.sortAt?.toISOString() ?? i}-${i}`}>
                  <td className={tdClass}>
                    <Tag tone={TRANSFER_TONE[r.problem]}>{TRANSFER_LABEL[r.problem]}</Tag>
                  </td>
                  <td className={`${tdClass} font-mono`}>
                    {r.trackerCode ?? "-"}
                    {r.trackerStatus ? <span className="text-zinc-500"> ({r.trackerStatus.toLowerCase()})</span> : null}
                  </td>
                  <td className={tdClass}>{r.fromLabel ?? "-"}</td>
                  <td className={tdClass}>{r.toLabel ?? "-"}</td>
                  <td className={tdClass}>{when(r.dispatchedAt)}</td>
                  <td className={tdClass}>
                    <span className="font-mono">{r.pharmacyRef ?? "-"}</span>
                    {r.pharmacyStatus ? <span className="text-zinc-500"> ({r.pharmacyStatus})</span> : null}
                  </td>
                  <td className={tdClass}>
                    {when(r.pharmacyRequestedAt)}
                    {r.pharmacyRequestedBy ? <span className="text-zinc-500"> by {r.pharmacyRequestedBy}</span> : null}
                  </td>
                  <td className={tdClass}>{r.trackerQuantity ?? "-"}</td>
                  <td className={tdClass}>{r.pharmacyQuantity ?? "-"}</td>
                  <td className={`${tdClass} font-mono`}>{signed(r.difference)}</td>
                </tr>
              ))}
              {transfers.length === 0 ? (
                <tr>
                  <td className={tdClass} colSpan={10}>
                    {noTransfers ? "Nothing to show." : "Every dispatched transfer agrees with a Pharmacy transfer."}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
          <Pagination info={transferPage} pathname="/reports/pharmacy" params={{ hpage: keep.hpage, spage: keep.spage }} param="tpage" noun="transfers" />
        </div>
      </section>
            ),
          },
        ]}
      />
    </div>
  );
}
