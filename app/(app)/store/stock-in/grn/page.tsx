import Link from "next/link";
import { requirePermission } from "@/server/auth/session";
import { listGrnSummaries } from "@/server/services/grn.service";
import { tableClass, tdClass, thClass } from "@/components/ui/styles";
import { Pagination } from "@/components/ui/Pagination";
import { pageOfArray, parsePage } from "@/lib/pagination";

export const metadata = { title: "Receive a Pharmacy GRN" };

export default async function GrnListPage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  await requirePermission("stock_in");
  const sp = await searchParams;
  const grnPage = pageOfArray(await listGrnSummaries(), parsePage(sp.page));
  const grns = grnPage.rows;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-[22px] font-bold tracking-tight">Receive a Pharmacy GRN</h1>
        <p className="mt-1 max-w-3xl text-sm text-zinc-500">
          GRNs loaded from the Pharmacy exports (an admin uploads them under Imports). Open one to receive its lines:
          quantity, batch number, expiry and supplier come from Pharmacy, and each line becomes a batch with labels.
          For stock that is not on a GRN, use{" "}
          <Link href="/store/stock-in" className="underline">
            manual stock in
          </Link>
          .
        </p>
      </div>

      <section className="overflow-x-auto rounded-xl border border-line bg-surface px-2 py-1">
        <table className={tableClass}>
          <thead>
            <tr>
              <th className={thClass}>GRN</th>
              <th className={thClass}>Supplier</th>
              <th className={thClass}>Lines</th>
              <th className={thClass}>Received</th>
              <th className={thClass}>Total quantity</th>
              <th className={thClass}>Loaded</th>
              <th className={thClass}></th>
            </tr>
          </thead>
          <tbody>
            {grns.map((g) => (
              <tr key={g.grnRef}>
                <td className={`${tdClass} font-mono`}>{g.grnRef}</td>
                <td className={tdClass}>{g.supplier ?? "-"}</td>
                <td className={tdClass}>{g.lines}</td>
                <td className={tdClass}>
                  {g.receivedLines} of {g.lines}
                </td>
                <td className={tdClass}>{g.totalQuantity}</td>
                <td className={tdClass}>{g.importedAt.toLocaleString("en-GB")}</td>
                <td className={tdClass}>
                  {g.receivedLines === g.lines ? (
                    <Link
                      href={`/store/stock-in/grn/${encodeURIComponent(g.grnRef)}`}
                      className="inline-block rounded-lg border border-line bg-surface px-3 py-1.5 text-xs font-semibold text-ink hover:bg-brand-soft"
                    >
                      View
                    </Link>
                  ) : (
                    <Link
                      href={`/store/stock-in/grn/${encodeURIComponent(g.grnRef)}`}
                      className="inline-block rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-brand-ink hover:brightness-95"
                    >
                      Receive
                    </Link>
                  )}
                </td>
              </tr>
            ))}
            {grns.length === 0 ? (
              <tr>
                <td className={tdClass} colSpan={7}>
                  No GRNs have been loaded yet. Ask an admin to upload one under Imports.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
        <Pagination info={grnPage} pathname="/store/stock-in/grn" noun="GRNs" />
      </section>
    </div>
  );
}
