import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePermission } from "@/server/auth/session";
import { getPackView } from "@/server/services/containment.service";
import {
  monoChipClass,
  pageSubtitleClass,
  pageTitleClass,
  panelClass,
} from "@/components/ui/styles";
import { LabelButtons } from "../../LabelButtons";
import { BackLink, BottleGrid, Detail, PrintedTag, ShowingNote } from "../../ContainmentBits";

export const metadata = { title: "Pack" };

/** One pack or roll: where it came from, and the bottles in it (each links to its own history). */
export default async function PackPage({ params }: { params: Promise<{ code: string }> }) {
  await requirePermission("stock_in");
  const { code } = await params;
  const pack = await getPackView(code);
  if (!pack) notFound();

  const noun = /^rolls?$/i.test(pack.unit.trim()) ? "Roll" : "Pack";
  const hasBottles = pack.totalBottles > 0;
  // Bottles already sent out on a transfer are struck through and left out of the next print.
  const transferredCount = pack.bottles.filter((b) => b.transferred).length;
  const printable = pack.bottles.length - transferredCount;
  // Up one level: the carton it came in, or the batch when it was received with no carton.
  const backHref = pack.cartonCode ? `/store/stock-in/carton/${pack.cartonCode}` : `/store/stock-in/${pack.batchCode}`;

  return (
    <div className="flex flex-col gap-5">
      <div>
        <BackLink href={backHref} />
        <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
          <h1 className={pageTitleClass}>
            {noun} <span className="font-mono">{pack.code}</span>
          </h1>
          <LabelButtons pack={pack.code} only="pack" label={`Open ${noun.toLowerCase()} label PDF`} single />
        </div>
        <p className={pageSubtitleClass}>
          {pack.itemName}. {pack.piecesPerPack.toLocaleString("en-GB")} {pack.piecesPerPack === 1 ? "piece" : "pieces"}.
          Scan this {noun.toLowerCase()} to send all of it, or pieces from it.
        </p>
      </div>

      <section className={`${panelClass} grid gap-x-8 gap-y-5 sm:grid-cols-2 lg:grid-cols-3`}>
        <Detail label="Item">{pack.itemName}</Detail>
        <Detail label="Carton">
          {pack.cartonCode ? (
            <Link href={`/store/stock-in/carton/${pack.cartonCode}`} className={`${monoChipClass} underline`}>
              {pack.cartonCode}
            </Link>
          ) : (
            "Not in a carton"
          )}
        </Detail>
        <Detail label="Batch">
          <Link href={`/store/stock-in/${pack.batchCode}`} className={`${monoChipClass} underline`}>
            {pack.batchCode}
          </Link>
        </Detail>
        <Detail label="Delivery">
          {pack.deliveryCode ? (
            <Link href={`/store/stock-in/delivery/${pack.deliveryCode}`} className={`${monoChipClass} underline`}>
              {pack.deliveryCode}
            </Link>
          ) : (
            "-"
          )}
        </Detail>
        <Detail label="Received into">{pack.locationName}</Detail>
        <Detail label="Lot and expiry">
          {pack.lotNo ?? "-"} / {pack.expiryDate ?? "-"}
        </Detail>
        <Detail label="Pack label">
          <PrintedTag printedAt={pack.labelPrintedAt} />
        </Detail>
      </section>

      {hasBottles ? (
        <section className={`${panelClass} flex flex-col gap-4`}>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h2 className="text-[17px] font-semibold">
                Bottles in this {noun.toLowerCase()}{" "}
                <span className="font-normal text-muted">({pack.totalBottles.toLocaleString("en-GB")})</span>
              </h2>
              <p className="mt-1 text-sm text-zinc-500">
                Open a bottle to see its history. Print the labels of every bottle in this {noun.toLowerCase()} together.
                {transferredCount > 0
                  ? ` ${transferredCount.toLocaleString("en-GB")} transferred out (struck through) will not be printed again.`
                  : ""}
              </p>
            </div>
            {printable > 0 ? <LabelButtons pack={pack.code} only="bottles" label="Print bottle labels" /> : null}
          </div>
          <BottleGrid bottles={pack.bottles} />
          <ShowingNote shown={pack.bottles.length} total={pack.totalBottles} noun="bottles" />
        </section>
      ) : (
        <section className={panelClass}>
          <h2 className="mb-1 text-[17px] font-semibold">Counted by the piece</h2>
          <p className="text-sm text-zinc-500">
            This {noun.toLowerCase()} is counted stock, so its pieces have no labels of their own. The{" "}
            {noun.toLowerCase()} label above is the one to scan.
          </p>
        </section>
      )}
    </div>
  );
}
