import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePermission } from "@/server/auth/session";
import { getCartonView } from "@/server/services/containment.service";
import {
  monoChipClass,
  pageSubtitleClass,
  pageTitleClass,
  panelClass,
  tableClass,
  tdClass,
  thClass,
} from "@/components/ui/styles";
import { LabelButtons } from "../../LabelButtons";
import { BackLink, BottleGrid, Detail, PrintedTag, RowActions, ShowingNote } from "../../ContainmentBits";

export const metadata = { title: "Carton" };

/** One carton: what it held, the packs in it (each opens its own page), and a print button for each level. */
export default async function CartonPage({ params }: { params: Promise<{ code: string }> }) {
  await requirePermission("stock_in");
  const { code } = await params;
  const carton = await getCartonView(code);
  if (!carton) notFound();

  const packNoun = /^rolls?$/i.test(carton.unit.trim()) ? "roll" : "pack";
  const packNounPlural = `${packNoun}s`;
  const hasPacks = carton.totalPacks > 0;
  const hasLoose = carton.totalLooseBottles > 0;
  const packsPrinted = carton.packs.filter((p) => p.labelPrintedAt).length;

  return (
    <div className="flex flex-col gap-5">
      <div>
        <BackLink href={`/store/stock-in/${carton.batchCode}`} />
        <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
          <h1 className={pageTitleClass}>
            Carton <span className="font-mono">{carton.code}</span>
          </h1>
          <LabelButtons carton={carton.code} only="carton" label="Open carton label PDF" single />
        </div>
        <p className={pageSubtitleClass}>
          {carton.itemName}. Held {carton.packsCount.toLocaleString("en-GB")}{" "}
          {carton.packsCount === 1 ? packNoun : packNounPlural}, {carton.piecesCount.toLocaleString("en-GB")}{" "}
          {carton.piecesCount === 1 ? "piece" : "pieces"} when it was received.
        </p>
      </div>

      <section className={`${panelClass} grid gap-x-8 gap-y-5 sm:grid-cols-2 lg:grid-cols-3`}>
        <Detail label="Item">{carton.itemName}</Detail>
        <Detail label="Batch">
          <Link href={`/store/stock-in/${carton.batchCode}`} className={`${monoChipClass} underline`}>
            {carton.batchCode}
          </Link>
        </Detail>
        <Detail label="Delivery">
          {carton.deliveryCode ? (
            <Link href={`/store/stock-in/delivery/${carton.deliveryCode}`} className={`${monoChipClass} underline`}>
              {carton.deliveryCode}
            </Link>
          ) : (
            "-"
          )}
        </Detail>
        <Detail label="Received into">{carton.locationName}</Detail>
        <Detail label="Lot">{carton.lotNo ?? "-"}</Detail>
        <Detail label="Expiry">{carton.expiryDate ?? "-"}</Detail>
      </section>

      {hasPacks ? (
        <section className={`${panelClass} flex flex-col gap-4`}>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h2 className="text-[17px] font-semibold">
                {packNoun === "roll" ? "Rolls" : "Packs"} in this carton{" "}
                <span className="font-normal text-muted">({carton.totalPacks.toLocaleString("en-GB")})</span>
                {packsPrinted < carton.packs.length ? (
                  <span className="ml-3 text-sm font-normal text-muted">
                    {packsPrinted} of {carton.packs.length} labels printed
                  </span>
                ) : (
                  <span className="ml-3 text-sm font-normal text-muted">All labels printed</span>
                )}
              </h2>
              <p className="mt-1 text-sm text-zinc-500">
                Open {packNoun === "roll" ? "a roll" : "a pack"} to see what is in it and print its labels. Print one
                label from its row, or all {packNoun} labels of this carton together.
              </p>
            </div>
            <LabelButtons carton={carton.code} only="packs" label={`Print ${packNoun} labels`} />
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
                {carton.packs.map((p) => (
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
          <ShowingNote shown={carton.packs.length} total={carton.totalPacks} noun={packNounPlural} />
        </section>
      ) : null}

      {hasLoose ? (
        <section className={`${panelClass} flex flex-col gap-4`}>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h2 className="text-[17px] font-semibold">
                {hasPacks ? "Bottles in this carton outside a pack" : "Bottles in this carton"}{" "}
                <span className="font-normal text-muted">({carton.totalLooseBottles.toLocaleString("en-GB")})</span>
              </h2>
              <p className="mt-1 text-sm text-zinc-500">These bottles sit straight in the carton, with no pack around them.</p>
            </div>
            <LabelButtons carton={carton.code} only="bottles" label="Print bottle labels" />
          </div>
          <BottleGrid bottles={carton.looseBottles} />
          <ShowingNote shown={carton.looseBottles.length} total={carton.totalLooseBottles} noun="bottles" />
        </section>
      ) : null}

      {!hasPacks && !hasLoose ? (
        <section className={panelClass}>
          <h2 className="mb-1 text-[17px] font-semibold">Nothing labelled inside</h2>
          <p className="text-sm text-zinc-500">
            This carton has no pack or bottle labels under it. The carton label above is the only one.
          </p>
        </section>
      ) : null}
    </div>
  );
}
