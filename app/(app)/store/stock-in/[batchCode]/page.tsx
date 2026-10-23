import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePermission } from "@/server/auth/session";
import { getBatchSummary } from "@/server/services/labels.service";
import { getBatchParts } from "@/server/services/transfer.service";
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
import { BatchTabs } from "./BatchTabs";
import { describeRequestQuantity, isPackUnit } from "@/lib/pack-size";

export const metadata = { title: "Batch labels" };

export default async function BatchLabelsPage({ params }: { params: Promise<{ batchCode: string }> }) {
  await requirePermission("stock_in");
  const { batchCode } = await params;
  const batch = await getBatchSummary(batchCode);
  if (!batch) notFound();
  const parts = await getBatchParts(batch.code);

  const isSerial = batch.trackingMode === "SERIAL";
  // Packs and rolls get their own PK... labels. Stock received before pack labels existed has none.
  const hasPacks = !isSerial && batch.packCount > 0;
  const packNoun = /^rolls?$/i.test(batch.unit.trim()) ? "roll" : "pack";

  return (
    <div className="flex flex-col gap-5">
      <div>
        <Link
          href={batch.deliveryCode ? `/store/stock-in/delivery/${batch.deliveryCode}` : "/store/stock-in"}
          className="mb-4 flex w-fit items-center gap-1.5 text-sm font-semibold text-side-title hover:underline"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M10 3L5 8l5 5" />
          </svg>
          Back
        </Link>
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
          <LabelButtons batch={batch.code} only="batch" label="Open batch label PDF" single />
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
        </p>
      </div>

      <BatchTabs
        labels={
          <>
      {isSerial || hasPacks ? (
        <section className={`${panelClass} flex flex-col gap-4 lg:flex-row-reverse lg:items-center lg:justify-between lg:gap-8`}>
          <div className="shrink-0">
            <LabelButtons
              batch={batch.code}
              only="items"
              label={isSerial ? "Print bottle labels" : `Print ${packNoun} labels`}
            />
          </div>
          {isSerial ? (
            <div className="min-w-0 lg:flex-1">
              <h3 className="mb-2 text-sm font-semibold">First serials in this batch</h3>
              <ul className="flex flex-wrap gap-2">
                {batch.sampleSerials.map((s) => (
                  <li key={s} className={monoChipClass}>
                    {s}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <div className="min-w-0 lg:flex-1">
              <h3 className="mb-2 text-sm font-semibold">First {packNoun} codes in this batch</h3>
              <ul className="flex flex-wrap gap-2">
                {batch.samplePacks.map((c) => (
                  <li key={c} className={monoChipClass}>
                    {c}
                  </li>
                ))}
              </ul>
              {batch.packCount > batch.samplePacks.length ? (
                <p className="mt-3 text-sm text-zinc-500">
                  Showing {batch.samplePacks.length} of {batch.packCount}.
                </p>
              ) : null}
            </div>
          )}
        </section>
      ) : (
        <section className={`${panelClass} flex flex-col gap-2`}>
          <h2 className="text-[17px] font-semibold">Batch label only</h2>
          <p className="text-sm text-zinc-500">
            This stock was received before pack labels existed, so there are no labels for the individual packs. One
            barcode identifies the whole batch: print as many copies of the batch label as you need.
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
