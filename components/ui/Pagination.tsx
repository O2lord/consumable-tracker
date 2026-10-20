import Link from "next/link";
import { pageWindow, type PageInfo } from "@/lib/pagination";

const pill = "inline-flex min-h-9 min-w-9 items-center justify-center rounded-lg px-3 text-sm font-medium transition-colors";
const idle = `${pill} border border-line bg-surface text-ink hover:bg-brand-soft`;
const current = `${pill} bg-brand font-semibold text-brand-ink`;
const disabled = `${pill} cursor-not-allowed border border-line bg-surface text-muted opacity-50`;

/**
 * Previous / numbered / Next links under a table. The page number goes in the URL as ?page=N (or `param`, when a
 * page holds two lists), and `params` carries any other query values (a tab, a filter) so they survive a page change.
 * Renders nothing when everything fits on one page.
 */
export function Pagination({
  info,
  pathname,
  params = {},
  param = "page",
  noun = "rows",
}: {
  info: PageInfo;
  pathname: string;
  params?: Record<string, string | undefined>;
  param?: string;
  noun?: string;
}) {
  if (info.totalPages <= 1) return null;

  const href = (n: number) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v && k !== param) qs.set(k, v);
    if (n > 1) qs.set(param, String(n));
    const s = qs.toString();
    return s ? `${pathname}?${s}` : pathname;
  };

  const first = info.offset + 1;
  const last = Math.min(info.offset + info.pageSize, info.total);

  return (
    <nav aria-label="Pagination" className="mt-4 flex flex-wrap items-center justify-between gap-3">
      <p className="text-sm text-muted">
        Showing {first}-{last} of {info.total} {noun}
      </p>
      <div className="flex flex-wrap items-center gap-1.5">
        {info.page > 1 ? (
          <Link href={href(info.page - 1)} className={idle} rel="prev">
            Previous
          </Link>
        ) : (
          <span className={disabled} aria-disabled="true">
            Previous
          </span>
        )}
        {pageWindow(info.page, info.totalPages).map((n, i) =>
          n === null ? (
            <span key={`gap-${i}`} className="px-1 text-muted" aria-hidden="true">
              …
            </span>
          ) : n === info.page ? (
            <span key={n} className={current} aria-current="page">
              {n}
            </span>
          ) : (
            <Link key={n} href={href(n)} className={idle} aria-label={`Page ${n}`}>
              {n}
            </Link>
          ),
        )}
        {info.page < info.totalPages ? (
          <Link href={href(info.page + 1)} className={idle} rel="next">
            Next
          </Link>
        ) : (
          <span className={disabled} aria-disabled="true">
            Next
          </span>
        )}
      </div>
    </nav>
  );
}
