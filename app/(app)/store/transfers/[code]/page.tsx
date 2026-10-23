import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePermission } from "@/server/auth/session";
import {
  getTransferDetail,
  listRecentCarriers,
  type TransferDetail,
} from "@/server/services/transfer.service";
import { ActionForm } from "@/components/forms/ActionForm";
import { ColdStorageTag } from "@/components/ui/ColdStorageTag";
import { PackEquivalent } from "@/components/ui/PackEquivalent";
import { TransferRoute, TransferStatusPill } from "@/components/ui/TransferMeta";
import {
  linkButtonClass,
  monoChipClass,
  pageSubtitleClass,
  panelClass,
  tableClass,
  tdClass,
} from "@/components/ui/styles";
import { Tabs } from "@/components/ui/Tabs";
import { ConfirmDispatchBar } from "./ConfirmDispatchBar";
import { DraftBuilder } from "./DraftBuilder";
import { cancelTransferAction, removeItemAction } from "./actions";

export const metadata = { title: "Transfer" };

const SERIAL_ROWS_SHOWN = 300;

/** Small uppercase column headings, as in the transfer design. */
const headClass =
  "border-b border-line px-2.5 py-2 text-xs font-semibold uppercase tracking-wider text-side-title";

/** A bulk quantity: "10 pieces" when the line is counted in loose pieces, else the number with its pack equivalent. */
function BulkAmount({ value, item }: { value: number; item: TransferDetail["quantityItems"][number] }) {
  if (item.inPieces) {
    return (
      <>
        {value.toLocaleString("en-GB")}
        <span className="ml-1 text-xs text-muted">{value === 1 ? "piece" : "pieces"}</span>
      </>
    );
  }
  return (
    <>
      {value}
      <PackEquivalent quantity={value} unit={item.unit} packSize={item.packSize} confirmed={item.packSizeConfirmed} />
    </>
  );
}

function serialStatus(i: TransferDetail["serialItems"][number], draft: boolean): string {
  if (draft) return "On draft";
  if (i.resolution === "FOUND") return "Missing, then found";
  if (i.resolution === "WRITTEN_OFF") return "Missing, written off";
  if (i.received) return "Received";
  if (i.missing > 0) return "Missing";
  return "In transit";
}

/** One label-over-value pair in the timeline card. */
function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="text-[13px] text-muted">
      {label}
      <b className="mt-0.5 block text-sm font-semibold text-ink">{children}</b>
    </div>
  );
}

export default async function TransferPage({ params }: { params: Promise<{ code: string }> }) {
  await requirePermission("dispatch");
  const { code } = await params;
  const detail = await getTransferDetail(decodeURIComponent(code));
  if (!detail) notFound();

  const { transfer: t, serialItems, quantityItems, totals } = detail;
  const draft = t.status === "DRAFT";
  const recentCarriers = draft ? await listRecentCarriers() : [];
  const hasSlip = t.status !== "DRAFT" && t.status !== "CANCELLED";
  // Open on the tab that has something in it, so a bottles-only transfer does not open on an empty list.
  const firstTab = quantityItems.length === 0 && serialItems.length > 0 ? "bottles" : "bulk";

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <TransferStatusPill status={t.status} withIcon />
        {draft ? (
          <div className="flex flex-wrap items-center gap-3">
            <DraftBuilder
              transferId={t.id}
              code={t.code}
              fromName={detail.fromName}
              toName={detail.toName}
              bottleCount={totals.serialCount}
              bulkTotal={totals.quantityTotal}
              pieceTotal={totals.pieceTotal}
              bottles={serialItems.map((i) => ({ id: i.itemId, serial: i.serial, itemName: i.itemName }))}
              bulk={quantityItems.map((i) => ({
                id: i.itemId,
                batchCode: i.batchCode,
                itemName: i.itemName,
                quantity: i.dispatched,
                inPieces: i.inPieces,
              }))}
            />
            <ActionForm
              action={cancelTransferAction}
              submitLabel="Cancel this draft"
              danger
              buttonClassName="rounded-lg border border-red-300 bg-surface px-4 py-2 text-sm font-semibold text-red-700 hover:bg-red-50 disabled:opacity-60"
              confirm="Cancel this draft? Scanned items are released."
            >
              <input type="hidden" name="transferId" value={t.id} />
            </ActionForm>
          </div>
        ) : null}
      </div>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-1.5">
          <h1 className="font-mono text-[28px] font-bold tracking-tight">{t.code}</h1>
          <div className="text-[15px]">
            <TransferRoute from={detail.fromName} to={detail.toName} plain={draft} />
          </div>
          {draft ? <p className={pageSubtitleClass}>Started by {detail.createdByName}</p> : null}
        </div>
        {hasSlip ? (
          <div className="flex flex-wrap gap-3">
            <a href={`/api/transfers/${t.code}?format=label`} target="_blank" rel="noreferrer" className={linkButtonClass}>
              Open barcode label (PDF)
            </a>
            <a href={`/api/transfers/${t.code}?format=pdf`} target="_blank" rel="noreferrer" className={linkButtonClass}>
              Open transfer slip (PDF)
            </a>
            {t.status === "RECEIVED_WITH_DISCREPANCY" ? (
              <Link href="/reports/discrepancies" className={linkButtonClass}>
                See discrepancies
              </Link>
            ) : null}
          </div>
        ) : null}
      </div>

      {!draft || detail.parts.length > 0 || t.note || detail.requestCode ? (
        <section className={`${panelClass} flex flex-col gap-4`}>
          {!draft ? (
            <div className="flex flex-wrap gap-x-8 gap-y-3">
              <Fact label="Started by">{detail.createdByName}</Fact>
              {detail.dispatchedByName && t.dispatchedAt ? (
                <Fact label="Dispatched">{t.dispatchedAt.toLocaleString("en-GB")}</Fact>
              ) : null}
              {t.dispatchedAt ? <Fact label="Carried by">{t.carriedByName ?? "Not recorded"}</Fact> : null}
              {detail.receiptStartedByName ? (
                <Fact label="Received by">{detail.receiptStartedByName}</Fact>
              ) : null}
              {detail.receiptClosedByName && t.receiptClosedAt ? (
                <Fact label="Receipt closed">
                  {t.receiptClosedAt.toLocaleString("en-GB")} by {detail.receiptClosedByName}
                </Fact>
              ) : null}
              {detail.requestCode ? (
                <Fact label="For request">
                  <Link href={`/store/requests/${detail.requestCode}`} className="font-mono text-side-title underline">
                    {detail.requestCode}
                  </Link>
                </Fact>
              ) : null}
            </div>
          ) : detail.requestCode ? (
            <p className="text-sm">
              For request{" "}
              <Link href={`/store/requests/${detail.requestCode}`} className="font-mono font-semibold text-side-title underline">
                {detail.requestCode}
              </Link>
            </p>
          ) : null}

          {t.note ? <p className="text-sm">Note: {t.note}</p> : null}
          {detail.parts.length > 0 ? (
            <div className="flex flex-wrap items-center gap-2 text-sm text-muted">
              <span>Batch parts on this transfer:</span>
              {detail.parts.map((p) => (
                <span key={`${p.batchCode}-${p.letter}`} className={monoChipClass}>
                  {p.batchCode} part {p.letter}
                </span>
              ))}
            </div>
          ) : null}
        </section>
      ) : null}

      <Tabs
        label="Transfer items"
        initialId={firstTab}
        tabs={[
          {
            id: "bulk",
            label: "Bulk items",
            count: totals.quantityTotal + totals.pieceTotal,
            content: (
              <section className={`${panelClass} overflow-x-auto`}>
                {quantityItems.length > 0 ? (
                  <p className="mb-2 text-sm text-muted">
                    {[
                      totals.quantityTotal > 0 ? `${totals.quantityTotal}` : null,
                      totals.pieceTotal > 0
                        ? `${totals.pieceTotal.toLocaleString("en-GB")} ${totals.pieceTotal === 1 ? "piece" : "pieces"}`
                        : null,
                    ]
                      .filter(Boolean)
                      .join(" and ")}{" "}
                    in {quantityItems.length} batch{quantityItems.length === 1 ? "" : "es"}
                  </p>
                ) : null}
                <table className={tableClass}>
                  <thead>
                    <tr>
                      <th className={headClass}>Batch</th>
                      <th className={headClass}>Item</th>
                      <th className={headClass}>Sent</th>
                      {!draft ? <th className={headClass}>Received</th> : null}
                      {!draft ? <th className={headClass}>Missing</th> : null}
                      {draft ? (
                        <th className={headClass}>
                          <span className="sr-only">Remove</span>
                        </th>
                      ) : null}
                    </tr>
                  </thead>
                  <tbody>
                    {quantityItems.map((i) => (
                      <tr key={i.itemId}>
                        <td className={`${tdClass} font-mono text-[13px]`}>{i.batchCode}</td>
                        <td className={tdClass}>
                          {i.itemName}
                          <ColdStorageTag cold={i.coldStorage} />
                        </td>
                        <td className={tdClass}>
                          <BulkAmount value={i.dispatched} item={i} />
                        </td>
                        {!draft ? (
                          <td className={tdClass}>
                            {i.received != null ? <BulkAmount value={i.received} item={i} /> : "-"}
                          </td>
                        ) : null}
                        {!draft ? (
                          <td className={tdClass}>
                            {i.missing > 0
                              ? `${i.missing}${i.inPieces ? (i.missing === 1 ? " piece" : " pieces") : ""} (found ${i.found}, written off ${i.writtenOff})`
                              : "-"}
                          </td>
                        ) : null}
                        {draft ? (
                          <td className={tdClass}>
                            <ActionForm action={removeItemAction} submitLabel="Remove" compact className="flex gap-2">
                              <input type="hidden" name="transferId" value={t.id} />
                              <input type="hidden" name="code" value={t.code} />
                              <input type="hidden" name="itemId" value={i.itemId} />
                            </ActionForm>
                          </td>
                        ) : null}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {quantityItems.length === 0 ? (
                  <p className="py-9 text-center text-sm text-muted">
                    {draft ? "No bulk items added yet." : "No bulk items on this transfer."}
                  </p>
                ) : null}
              </section>
            ),
          },
          {
            id: "bottles",
            label: "Bottles",
            count: totals.serialCount,
            content: (
              <section className={`${panelClass} overflow-x-auto`}>
                {!draft && t.status !== "CANCELLED" && serialItems.length > 0 ? (
                  <p className="mb-2 text-sm text-muted">{totals.serialReceived} received</p>
                ) : null}
                <table className={tableClass}>
                  <thead>
                    <tr>
                      <th className={headClass}>Serial</th>
                      <th className={headClass}>Item</th>
                      <th className={headClass}>Status</th>
                      {draft ? (
                        <th className={headClass}>
                          <span className="sr-only">Remove</span>
                        </th>
                      ) : null}
                    </tr>
                  </thead>
                  <tbody>
                    {serialItems.slice(0, SERIAL_ROWS_SHOWN).map((i) => (
                      <tr key={i.itemId}>
                        <td className={`${tdClass} font-mono text-[13px]`}>{i.serial}</td>
                        <td className={tdClass}>{i.itemName}</td>
                        <td className={tdClass}>{serialStatus(i, draft)}</td>
                        {draft ? (
                          <td className={tdClass}>
                            <ActionForm action={removeItemAction} submitLabel="Remove" compact className="flex gap-2">
                              <input type="hidden" name="transferId" value={t.id} />
                              <input type="hidden" name="code" value={t.code} />
                              <input type="hidden" name="itemId" value={i.itemId} />
                            </ActionForm>
                          </td>
                        ) : null}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {serialItems.length === 0 ? (
                  <p className="py-9 text-center text-sm text-muted">
                    {draft ? "No bottles added yet." : "No bottles on this transfer."}
                  </p>
                ) : null}
                {serialItems.length > SERIAL_ROWS_SHOWN ? (
                  <p className="mt-2 text-sm text-muted">
                    Showing the first {SERIAL_ROWS_SHOWN} of {serialItems.length}. The full list is in the transfer
                    JSON at /api/transfers/{t.code}.
                  </p>
                ) : null}
              </section>
            ),
          },
        ]}
      />

      {draft ? (
        <ConfirmDispatchBar
          transferId={t.id}
          code={t.code}
          total={totals.all}
          pieceTotal={totals.pieceTotal}
          recentCarriers={recentCarriers}
        />
      ) : null}
    </div>
  );
}
