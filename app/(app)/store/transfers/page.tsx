import Link from "next/link";
import { requirePermission } from "@/server/auth/session";
import { listActiveLocations } from "@/server/services/catalog.service";
import { listTransfersPage } from "@/server/services/transfer.service";
import { TRANSFER_STATUSES } from "@/server/domain/types";
import { CreateTransferForm } from "./CreateTransferForm";
import { TransferTabs } from "./TransferTabs";
import {
  linkButtonClass,
  pageSubtitleClass,
  pageTitleClass,
  panelClass,
  tableClass,
  tdClass,
  thClass,
} from "@/components/ui/styles";
import { TransferRoute, TransferStatusPill } from "@/components/ui/TransferMeta";
import { Pagination } from "@/components/ui/Pagination";
import { parsePage } from "@/lib/pagination";

export const metadata = { title: "Transfers" };

const HISTORY_STATUSES = TRANSFER_STATUSES.filter((s) => s !== "DRAFT");

export default async function TransfersPage({
  searchParams,
}: {
  searchParams: Promise<{ dpage?: string; hpage?: string }>;
}) {
  const session = await requirePermission("dispatch");
  const sp = await searchParams;
  const [locations, draftPage, historyPage] = await Promise.all([
    listActiveLocations(),
    listTransfersPage({ statuses: ["DRAFT"] }, parsePage(sp.dpage)),
    listTransfersPage({ statuses: HISTORY_STATUSES }, parsePage(sp.hpage)),
  ]);
  const drafts = draftPage.rows;
  const history = historyPage.rows;
  const stores = locations.filter((l) => l.type === "STORE");
  const homeStore = stores.find((s) => s.id === session.homeLocationId);
  const destinations = locations.map((l) => ({ id: l.id, name: l.name }));

  const header = (
    <>
      <h1 className={pageTitleClass}>Transfers</h1>
      <p className={pageSubtitleClass}>
        Start a transfer, scan each bottle or enter bulk quantities, then confirm. Nothing leaves the store until you
        confirm.
      </p>
    </>
  );

  return (
    <div className="flex flex-col gap-6">
      {stores.length === 0 || locations.length < 2 ? (
        <>
          <div>{header}</div>
          <p className="max-w-xl rounded-xl border border-line bg-surface p-4 text-sm">
            A transfer needs a STORE location to send from and at least one other location to send to. Ask an admin to add them.
          </p>
        </>
      ) : (
        <CreateTransferForm
          header={header}
          stores={stores.map((s) => ({ id: s.id, name: s.name }))}
          destinations={destinations}
          defaultStoreId={homeStore?.id}
        />
      )}

      <TransferTabs
        draftCount={draftPage.total}
        historyCount={historyPage.total}
        initialTab={sp.hpage && !sp.dpage ? "history" : "drafts"}
        drafts={
          <section className={`${panelClass} overflow-x-auto`}>
            <table className={tableClass}>
              <thead>
                <tr>
                  <th className={thClass}>Transfer</th>
                  <th className={thClass}>Route</th>
                  <th className={`${thClass} text-left`}>Items so far</th>
                  <th className={thClass}>Started</th>
                  <th className={`${thClass} text-right`}>
                    <span className="sr-only">Open</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {drafts.map((t) => (
                  <tr key={t.id}>
                    <td className={tdClass}>
                      <Link href={`/store/transfers/${t.code}`} className="font-mono text-[13px] underline">
                        {t.code}
                      </Link>
                    </td>
                    <td className={tdClass}>
                      <TransferRoute from={t.fromName} to={t.toName} />
                    </td>
                    <td className={`${tdClass} text-left`}>{t.serialCount + t.quantityTotal}</td>
                    <td className={tdClass}>{t.createdAt.toLocaleString("en-GB")}</td>
                    <td className={`${tdClass} text-right`}>
                      <Link href={`/store/transfers/${t.code}`} className={linkButtonClass}>
                        Continue scanning
                      </Link>
                    </td>
                  </tr>
                ))}
                {drafts.length === 0 ? (
                  <tr>
                    <td className={tdClass} colSpan={5}>
                      No drafts.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
            <Pagination
              info={draftPage}
              pathname="/store/transfers"
              params={{ hpage: sp.hpage }}
              param="dpage"
              noun="drafts"
            />
          </section>
        }
        history={
          <section className={`${panelClass} overflow-x-auto`}>
            <table className={tableClass}>
              <thead>
                <tr>
                  <th className={thClass}>Transfer</th>
                  <th className={thClass}>Status</th>
                  <th className={thClass}>Route</th>
                  <th className={`${thClass} text-left`}>Items</th>
                  <th className={thClass}>Dispatched</th>
                </tr>
              </thead>
              <tbody>
                {history.map((t) => (
                  <tr key={t.id}>
                    <td className={tdClass}>
                      <Link href={`/store/transfers/${t.code}`} className="font-mono text-[13px] underline">
                        {t.code}
                      </Link>
                    </td>
                    <td className={tdClass}>
                      <TransferStatusPill status={t.status} />
                    </td>
                    <td className={tdClass}>
                      <TransferRoute from={t.fromName} to={t.toName} />
                    </td>
                    <td className={`${tdClass} text-left`}>{t.serialCount + t.quantityTotal}</td>
                    <td className={tdClass}>{t.dispatchedAt ? t.dispatchedAt.toLocaleString("en-GB") : "-"}</td>
                  </tr>
                ))}
                {history.length === 0 ? (
                  <tr>
                    <td className={tdClass} colSpan={5}>
                      No transfers yet.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
            <Pagination
              info={historyPage}
              pathname="/store/transfers"
              params={{ dpage: sp.dpage }}
              param="hpage"
              noun="transfers"
            />
          </section>
        }
      />
    </div>
  );
}
