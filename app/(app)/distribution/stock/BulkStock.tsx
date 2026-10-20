import type { ReactNode } from "react";
import { ColdStorageTag } from "@/components/ui/ColdStorageTag";
import { PackEquivalent } from "@/components/ui/PackEquivalent";
import { tableClass, tdClass, thClass } from "@/components/ui/styles";
import { isPackUnit, isPieceUnit } from "@/lib/pack-size";
import type { getLocationStock } from "@/server/services/stock.service";

type Row = Awaited<ReturnType<typeof getLocationStock>>["quantity"][number];

const num = (n: number) => n.toLocaleString("en-GB");

/** "1 roll", "3 rolls", "2 boxes": the item's own unit, for items that are neither packs nor pieces. */
function otherText(n: number, unit: string): string {
  const word = (unit ?? "").trim().toLowerCase() || "unit";
  const many = /(s|x|ch|sh)$/.test(word) ? `${word}es` : `${word}s`;
  return `${num(n)} ${n === 1 ? word : many}`;
}

/**
 * Sealed packs, loose pieces and any other unit are never added into one number. Each has its own column under
 * "On the shelf" and under "Used". Used is everything that left the shelf for use: issued to a patient or
 * department, plus recorded as used for a test. A pack item uses Packs (and Pieces once a pack is opened), a piece
 * item uses Pieces, and anything else (roll, box, litre) uses Other and shows its own unit.
 */
function figures(r: Row) {
  const none = { packs: null, pieces: 0, other: null };
  const outOf = r.issuedOut + r.usedOut;
  const piecesOut = r.issuedPieces + r.usedPieces;
  if (isPieceUnit(r.unit)) {
    return {
      shelf: { ...none, pieces: r.onHand + r.loose },
      used: { ...none, pieces: outOf + piecesOut },
    };
  }
  if (isPackUnit(r.unit)) {
    return {
      shelf: { ...none, packs: r.onHand, pieces: r.loose },
      used: { ...none, packs: outOf, pieces: piecesOut },
    };
  }
  return {
    shelf: { ...none, other: r.onHand, pieces: r.loose },
    used: { ...none, other: outOf, pieces: piecesOut },
  };
}

const dash = <span className="text-muted">-</span>;
const groupHead = `${thClass} border-l border-line text-center`;
const subHead = `${thClass} text-center`;
const cell = `${tdClass} text-center`;

/** Bulk items at a glance: On the shelf and Used, each split into Packs, Pieces and Other side by side. `pager` goes under the table. */
export function BulkStock({ rows, pager }: { rows: Row[]; pager?: ReactNode }) {
  return (
    <section className="overflow-x-auto rounded-xl border border-line bg-surface px-2 py-1">
      <table className={tableClass}>
        <thead>
          <tr>
            <th className={thClass} rowSpan={2}>
              Item
            </th>
            <th className={groupHead} colSpan={3}>
              On the shelf
            </th>
            <th className={groupHead} colSpan={3}>
              Used
            </th>
          </tr>
          <tr>
            <th className={`${subHead} border-l border-line`}>Packs</th>
            <th className={subHead}>Pieces</th>
            <th className={subHead}>Other</th>
            <th className={`${subHead} border-l border-line`}>Packs</th>
            <th className={subHead}>Pieces</th>
            <th className={subHead}>Other</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const { shelf, used } = figures(r);
            return (
              <tr key={r.batchCode}>
                <td className={tdClass}>
                  {r.itemName}
                  <ColdStorageTag cold={r.coldStorage} />
                </td>
                <td className={`${cell} border-l border-line`}>
                  {shelf.packs === null ? dash : num(shelf.packs)}
                  {shelf.packs !== null ? (
                    <PackEquivalent quantity={shelf.packs} unit={r.unit} packSize={r.packSize} confirmed={r.packSizeConfirmed} />
                  ) : null}
                </td>
                <td className={cell}>{shelf.pieces === 0 ? dash : num(shelf.pieces)}</td>
                <td className={cell}>{shelf.other === null ? dash : otherText(shelf.other, r.unit)}</td>
                <td className={`${cell} border-l border-line`}>
                  {used.packs === null ? dash : num(used.packs)}
                  {used.packs !== null ? (
                    <PackEquivalent quantity={used.packs} unit={r.unit} packSize={r.packSize} confirmed={r.packSizeConfirmed} />
                  ) : null}
                </td>
                <td className={cell}>{used.pieces === 0 ? dash : num(used.pieces)}</td>
                <td className={cell}>{used.other === null ? dash : otherText(used.other, r.unit)}</td>
              </tr>
            );
          })}
          {rows.length === 0 ? (
            <tr>
              <td className={tdClass} colSpan={7}>
                None.
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
      {pager}
    </section>
  );
}
