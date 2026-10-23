import Link from "next/link";
import { notFound } from "next/navigation";
import { can } from "@/server/auth/permissions";
import { requireSession } from "@/server/auth/session";
import { COUNT_REASON_LABEL, reasonsFor } from "@/server/domain/stock-count-rules";
import { canSeeCount, getCount } from "@/server/services/stock-count.service";
import { COUNT_STATUS_LABEL } from "@/types/stock-counts";
import { ActionForm } from "@/components/forms/ActionForm";
import { CancelCountButton } from "@/components/forms/CancelCountButton";
import { CountReasonFields } from "@/components/forms/CountReasonFields";
import { PackEquivalent } from "@/components/ui/PackEquivalent";
import { Tag } from "@/components/ui/Tag";
import { tableClass, tdClass, thClass } from "@/components/ui/styles";
import { cancelCountAction, postCountAction } from "../actions";

export const metadata = { title: "Stock count" };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const when = (d: Date) => d.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });

type Line = NonNullable<Awaited<ReturnType<typeof getCount>>>["lines"][number];

export default async function StockCountDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  const { id } = await params;
  if (!UUID_RE.test(id)) notFound();
  const count = await getCount(id);
  if (!count) notFound();

  const mayCount = can(session.role, "count_stock") && canSeeCount(session, count.locationId);
  const mayRead = mayCount || can(session.role, "view_reports");
  if (!mayRead) notFound();

  const open = count.status === "OPEN";
  // A line differs when its sealed packs or its loose pieces differ.
  const withVariance = count.lines.filter((l) => l.variance !== 0 || l.pieceVariance !== 0);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <p className="text-sm">
          <Link href={`/distribution/stock?tab=count`} className="underline">
            Stock counts
          </Link>
        </p>
        <h1 className="text-[22px] font-bold tracking-tight">Count at {count.locationName}</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Counted by {count.countedByName} on {when(count.countedAt)}.{" "}
          <Tag tone={count.status === "POSTED" ? "ok" : open ? "warn" : "brand"}>
            {COUNT_STATUS_LABEL[count.status] ?? count.status}
          </Tag>
        </p>
        {count.note ? <p className="mt-1 text-sm">Note: {count.note}</p> : null}
        {open ? (
          <p className="mt-2 max-w-3xl text-sm text-zinc-500">
            {withVariance.length === 0
              ? "Everything matched what the system expected. Post the count to record it."
              : `${withVariance.length} ${withVariance.length === 1 ? "line differs" : "lines differ"} from what the system expected. Choose a reason for each difference (sealed packs and loose pieces are explained separately), then post. If a count looks wrong, cancel it and count again.`}
          </p>
        ) : null}
      </div>

      {open && mayCount ? (
        <ActionForm
          action={postCountAction}
          submitLabel="Post count"
          resetOnSuccess={false}
          className="flex flex-col gap-4"
          extraActions={<CancelCountButton countId={count.id} action={cancelCountAction} />}
          confirm={
            withVariance.length === 0
              ? "Post this count? Nothing needs adjusting."
              : "Post this count? Each difference is written to the ledger as an adjustment and cannot be undone."
          }
        >
          <input type="hidden" name="countId" value={count.id} />
          <CountTable lines={count.lines} editable />
        </ActionForm>
      ) : (
        <CountTable lines={count.lines} editable={false} />
      )}
    </div>
  );
}

function VarianceTag({ variance }: { variance: number }) {
  return variance === 0 ? (
    <Tag tone="ok">Matches</Tag>
  ) : (
    <Tag tone="bad">
      {variance > 0 ? "+" : ""}
      {variance}
    </Tag>
  );
}

/** The reason for one figure (sealed packs or loose pieces) of a line: pickers while open, the saved reason after. */
function ReasonCell({
  l,
  editable,
  variance,
  reasonCode,
  note,
  reasonName,
  noteName,
  what,
}: {
  l: Line;
  editable: boolean;
  variance: number;
  reasonCode: string | null;
  note: string | null;
  reasonName: string;
  noteName: string;
  what: string;
}) {
  if (editable) {
    if (variance === 0) {
      // Every line sends all its reason fields, so the lists stay lined up with the line list.
      return (
        <>
          <input type="hidden" name={reasonName} value="" />
          <input type="hidden" name={noteName} value="" />
        </>
      );
    }
    return (
      <CountReasonFields
        reasonName={reasonName}
        noteName={noteName}
        reasonAriaLabel={`Reason for ${what} ${l.itemName} ${l.batchCode}`}
        noteAriaLabel={`Note for ${what} ${l.itemName} ${l.batchCode}`}
        placeholder={`Choose a reason (${what})`}
        options={reasonsFor(variance).map((r) => ({ value: r, label: COUNT_REASON_LABEL[r] }))}
      />
    );
  }
  if (reasonCode) {
    return (
      <>
        {COUNT_REASON_LABEL[reasonCode as keyof typeof COUNT_REASON_LABEL] ?? reasonCode}
        {note ? <span className="block text-xs text-zinc-500">{note}</span> : null}
      </>
    );
  }
  return <span className="text-zinc-400">-</span>;
}

function CountTable({ lines, editable }: { lines: Line[]; editable: boolean }) {
  return (
    <section className="overflow-x-auto rounded-xl border border-line bg-surface px-2 py-1">
      <table className={tableClass}>
        <thead>
          <tr>
            <th className={thClass}>Item</th>
            <th className={thClass}>Batch</th>
            <th className={thClass}>Counted</th>
            <th className={thClass}>Expected</th>
            <th className={thClass}>Difference</th>
            <th className={thClass}>Reason</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => {
            const hasPacks = l.counted !== null;
            const hasPieces = l.countedPieces !== null;
            // The labels only matter when a line shows both figures; one figure on its own is clear from the unit.
            const both = hasPacks && hasPieces;
            const packsLabel = both ? "Sealed packs" : null;
            return (
              <tr key={l.lineId} className="align-top">
                <td className={tdClass}>
                  {l.itemName}
                  {editable ? <input type="hidden" name="lineId" value={l.lineId} /> : null}
                </td>
                <td className={`${tdClass} font-mono`}>{l.batchCode}</td>
                <td className={tdClass}>
                  <div className="flex flex-col gap-3">
                    {hasPacks ? (
                      <div>
                        {packsLabel ? <span className="block text-xs text-zinc-500">{packsLabel}</span> : null}
                        {l.counted}
                        <PackEquivalent quantity={l.counted ?? 0} unit={l.unit} packSize={l.packSize} confirmed={l.packSizeConfirmed} />
                      </div>
                    ) : null}
                    {hasPieces ? (
                      <div>
                        <span className="block text-xs text-zinc-500">Loose pieces</span>
                        {l.countedPieces}
                      </div>
                    ) : null}
                  </div>
                </td>
                <td className={tdClass}>
                  <div className="flex flex-col gap-3">
                    {hasPacks ? (
                      <div>
                        {packsLabel ? <span className="block text-xs text-zinc-500">{packsLabel}</span> : null}
                        {l.expected}
                        <PackEquivalent quantity={l.expected} unit={l.unit} packSize={l.packSize} confirmed={l.packSizeConfirmed} />
                      </div>
                    ) : null}
                    {hasPieces ? (
                      <div>
                        <span className="block text-xs text-zinc-500">Loose pieces</span>
                        {l.expectedPieces}
                      </div>
                    ) : null}
                  </div>
                </td>
                <td className={tdClass}>
                  <div className="flex flex-col gap-3">
                    {hasPacks ? (
                      <div>
                        {packsLabel ? <span className="block text-xs text-zinc-500">{packsLabel}</span> : null}
                        <VarianceTag variance={l.variance} />
                      </div>
                    ) : null}
                    {hasPieces ? (
                      <div>
                        <span className="block text-xs text-zinc-500">Loose pieces</span>
                        <VarianceTag variance={l.pieceVariance} />
                      </div>
                    ) : null}
                  </div>
                </td>
                <td className={tdClass}>
                  <div className="flex flex-col gap-3">
                    {hasPacks ? (
                      <ReasonCell
                        l={l}
                        editable={editable}
                        variance={l.variance}
                        reasonCode={l.reasonCode}
                        note={l.note}
                        reasonName="reasonCode"
                        noteName="lineNote"
                        what="sealed packs"
                      />
                    ) : editable ? (
                      <ReasonCell
                        l={l}
                        editable
                        variance={0}
                        reasonCode={null}
                        note={null}
                        reasonName="reasonCode"
                        noteName="lineNote"
                        what="sealed packs"
                      />
                    ) : null}
                    {hasPieces ? (
                      <ReasonCell
                        l={l}
                        editable={editable}
                        variance={l.pieceVariance}
                        reasonCode={l.piecesReasonCode}
                        note={l.piecesNote}
                        reasonName="piecesReasonCode"
                        noteName="piecesNote"
                        what="loose pieces"
                      />
                    ) : editable ? (
                      <ReasonCell
                        l={l}
                        editable
                        variance={0}
                        reasonCode={null}
                        note={null}
                        reasonName="piecesReasonCode"
                        noteName="piecesNote"
                        what="loose pieces"
                      />
                    ) : null}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
