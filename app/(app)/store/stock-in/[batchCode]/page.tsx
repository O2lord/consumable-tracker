import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePermission } from "@/server/auth/session";
import { getBatchSummary } from "@/server/services/labels.service";
import { getBatchParts } from "@/server/services/transfer.service";
import { listCartonsOfBatch, listLoosePacksOfBatch } from "@/server/services/containment.service";
import {
  monoChipClass,
  pageSubtitleClass,
  pageTitleClass,
  panelClass,
  tableClass,
  tdClass,
  thClass,
} from "@/components/ui/styles";
import { LabelButtons } from "../LabelButtons";
import { BackLink, PrintedTag, RowActions, ShowingNote } from "../ContainmentBits";
import { BatchTabs } from "./BatchTabs";
import { describeRequestQuantity, isPackUnit } from "@/lib/pack-size";

export const metadata = { title: "Batch labels" };

/**
 * One batch, the top of the walk down a delivery: delivery -> batch -> carton -> pack -> bottle. This page lists the
 * level directly below the batch (its cartons, or its packs when it has no cartons) and each row opens the page of
 * what is inside it. Labels are printed one level at a time from those pages, never everything at once.
 */
export default async function BatchLabelsPage({ params }: { params: Promise<{ batchCode: string }> }) {
  await requirePermission("stock_in");
  const { batchCode } = await params;
  const batch = await getBatchSummary(batchCode);
  if (!batch) notFound();
  const parts = await getBatchParts(batch.code);

  const isSerial = batch.trackingMode === "SERIAL";
  // Cartons (CN...), packs and rolls (PK...) each get their own labels. Stock received before they existed, or by the
  // piece, has none of that level.
  const hasPacks = batch.packCount > 0;
  const hasCartons = batch.cartonCount > 0;
  const packNoun = /^rolls?$/i.test(batch.unit.trim()) ? "roll" : "pack";
  const packNounPlural = `${packNoun}s`;

  const cartonRows = hasCartons ? await listCartonsOfBatch(batch.id) : [];
  // With cartons, the packs are reached through them. Without, the packs are the level under the batch.
  const packRows = !hasCartons && hasPacks ? await listLoosePacksOfBatch(batch.id) : [];

  return (
    <div className="flex flex-col gap-5">
      <div>
        <BackLink href={batch.deliveryCode ? `/store/stock-in/delivery/${batch.deliveryCode}` : "/store/stock-in"} />
        <span className="inline-flex items-center gap-1.5 rounded-full bg-ok-soft px-2.5 py-0.5 text-xs font-semibold text-ok">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M3 8.5l3 3 7-7" />
          </svg>
          Stock recorded
        </span>
        <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-3">
          <h1 className={pageTitleClass}>
            {isSerial ? batch.quantity : describeRequestQuantity(batch.quantity, batch.unit, false)} x {batch.itemName}
          </h1>
          <LabelButtons batch={batch.code} only="batch" label="Print batch label" single />
        </div>
        <p className={pageSubtitleClass}>
          {!isSerial && isPackUnit(batch.unit) && batch.packSize > 1
            ? `${(batch.quantity * batch.packSize).toLocaleString("en-GB")} pieces in all. `
            : ""}
          Batch <span className="font-mono text-ink">{batch.code}</span>
          {batch.storeName ? ` in ${batch.storeName}` : ""}
          {batch.lotNo ? `, lot ${batch.lotNo}` : ""}
          {batch.expiryDate ? `, expires ${batch.expiryDate}` : ""}
          {batch.supplier ? `, from ${batch.supplier}` : ""}
          {hasCartons && batch.cartonContents
            ? `. Received as ${batch.cartonCount.toLocaleString("en-GB")} ${batch.cartonCount === 1 ? "carton" : "cartons"} of ${batch.cartonContents.pieces.toLocaleString("en-GB")} ${batch.cartonContents.pieces === 1 ? "piece" : "pieces"}`
            : ""}
        </p>
      </div>

      <BatchTabs
        labels={
          <>
            {hasCartons ? (
              <section className={`${panelClass} flex flex-col gap-4`}>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <h2 className="text-[17px] font-semibold">
                      Cartons <span className="font-normal text-muted">({batch.cartonCount.toLocaleString("en-GB")})</span>
                    </h2>
                    <p className="mt-1 max-w-xl text-sm text-zinc-500">
                      Open a carton to see the {packNounPlural} in it and print their labels. Packs and bottles are
                      printed from inside their carton, so only what you need comes out.
                    </p>
                  </div>
                  <LabelButtons batch={batch.code} only="cartons" label="Print carton labels" />
                </div>
                <div className="overflow-x-auto">
                  <table className={tableClass}>
                    <thead>
                      <tr>
                        <th className={thClass}>Carton</th>
                        <th className={thClass}>{packNoun === "roll" ? "Rolls" : "Packs"}</th>
                        <th className={thClass}>Pieces</th>
                        <th className={`${thClass} text-right`}>
                          <span className="sr-only">Actions</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {cartonRows.map((c) => (
                        <tr key={c.code}>
                          <td className={tdClass}>
                            <Link href={`/store/stock-in/carton/${c.code}`} className={`${monoChipClass} underline`}>
                              {c.code}
                            </Link>
                          </td>
                          <td className={tdClass}>{c.packsCount.toLocaleString("en-GB")}</td>
                          <td className={tdClass}>{c.piecesCount.toLocaleString("en-GB")}</td>
                          <td className={tdClass}>
                            <RowActions labelCode={c.code} open={`/store/stock-in/carton/${c.code}`} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <ShowingNote shown={cartonRows.length} total={batch.cartonCount} noun="cartons" />
              </section>
            ) : hasPacks ? (
              <section className={`${panelClass} flex flex-col gap-4`}>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <h2 className="text-[17px] font-semibold">
                      {packNoun === "roll" ? "Rolls" : "Packs"}{" "}
                      <span className="font-normal text-muted">({batch.packCount.toLocaleString("en-GB")})</span>
                    </h2>
                    <p className="mt-1 max-w-xl text-sm text-zinc-500">
                      This stock came in with no cartons. Open {packNoun === "roll" ? "a roll" : "a pack"} to see what
                      is in it and print its labels.
                    </p>
                  </div>
                  <LabelButtons batch={batch.code} only="packs" label={`Print ${packNoun} labels`} />
                </div>
                <div className="overflow-x-auto">
                  <table className={tableClass}>
                    <thead>
                      <tr>
                        <th className={thClass}>{packNoun === "roll" ? "Roll" : "Pack"}</th>
                        <th className={thClass}>Pieces</th>
                        <th className={thClass}>Label</th>
                        <th className={`${thClass} text-right`}>
                          <span className="sr-only">Actions</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {packRows.map((p) => (
                        <tr key={p.code}>
                          <td className={tdClass}>
                            <Link href={`/store/stock-in/pack/${p.code}`} className={`${monoChipClass} underline`}>
                              {p.code}
                            </Link>
                          </td>
                          <td className={tdClass}>{p.piecesPerPack.toLocaleString("en-GB")}</td>
                          <td className={tdClass}>
                            <PrintedTag printedAt={p.labelPrintedAt} />
                          </td>
                          <td className={tdClass}>
                            <RowActions labelCode={p.code} open={`/store/stock-in/pack/${p.code}`} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <ShowingNote shown={packRows.length} total={batch.packCount} noun={packNounPlural} />
              </section>
            ) : isSerial ? (
              <section className={`${panelClass} flex flex-col gap-4 lg:flex-row-reverse lg:items-center lg:justify-between lg:gap-8`}>
                <div className="flex shrink-0 flex-col gap-2">
                  <LabelButtons batch={batch.code} only="items" label="Print bottle labels" />
                </div>
                <div className="min-w-0 lg:flex-1">
                  <h2 className="mb-2 text-sm font-semibold">First serials in this batch</h2>
                  <ul className="flex flex-wrap gap-2">
                    {batch.sampleSerials.map((s) => (
                      <li key={s} className={monoChipClass}>
                        <Link href={`/reports/bottle/${s}`} className="underline">
                          {s}
                        </Link>
                      </li>
                    ))}
                  </ul>
                  <ShowingNote shown={batch.sampleSerials.length} total={batch.quantity} noun="serials" />
                </div>
              </section>
            ) : (
              <section className={`${panelClass} flex flex-col gap-2`}>
                <h2 className="text-[17px] font-semibold">Batch label only</h2>
                <p className="text-sm text-zinc-500">
                  This stock was received before pack labels existed, so there are no labels for the individual packs.
                  One barcode identifies the whole batch: print as many copies of the batch label as you need.
                </p>
              </section>
            )}
          </>
        }
        history={
          parts.length > 0 ? (
            <section className={`${panelClass} overflow-x-auto`}>
              <h2 className="mb-3 text-[17px] font-semibold">Where this batch went</h2>
              <table className={tableClass}>
                <thead>
                  <tr>
                    <th className={thClass}>Part</th>
                    <th className={thClass}>Sent to</th>
                    <th className={thClass}>Quantity</th>
                    <th className={thClass}>Transfer</th>
                  </tr>
                </thead>
                <tbody>
                  {parts.map((p) => (
                    <tr key={p.letter}>
                      <td className={`${tdClass} font-semibold`}>{p.letter}</td>
                      <td className={tdClass}>{p.toName}</td>
                      <td className={tdClass}>{p.quantity}</td>
                      <td className={`${tdClass} font-mono`}>
                        <Link href={`/store/transfers/${p.transferCode}`} className="underline">
                          {p.transferCode}
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ) : (
            <section className={panelClass}>
              <h2 className="mb-1 text-[17px] font-semibold">Where this batch went</h2>
              <p className="text-sm text-zinc-500">None of this batch has been sent anywhere yet.</p>
            </section>
          )
        }
      />
    </div>
  );
}
