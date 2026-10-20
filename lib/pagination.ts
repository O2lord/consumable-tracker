// Shared paging for list pages: the page number lives in the URL (?page=2), so a page can be bookmarked,
// refreshed and shared, and the server only ever loads one page of rows.
export const PAGE_SIZE = 20;

export interface PageInfo {
  /** 1-based, already clamped into 1..totalPages. */
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  /** Rows to skip for this page. */
  offset: number;
}

export interface Paged<T> extends PageInfo {
  rows: T[];
}

/** Reads ?page= from searchParams. Anything that is not a positive whole number is page 1. */
export function parsePage(raw: string | string[] | undefined): number {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

/** Works out the paging numbers for a total. A page past the end is pulled back to the last page. */
export function pageInfo(requestedPage: number, total: number, pageSize = PAGE_SIZE): PageInfo {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, Math.floor(requestedPage) || 1), totalPages);
  return { page, pageSize, total, totalPages, offset: (page - 1) * pageSize };
}

/** Pages an already-loaded array (for lists a service builds in memory). */
export function pageOfArray<T>(all: readonly T[], requestedPage: number, pageSize = PAGE_SIZE): Paged<T> {
  const info = pageInfo(requestedPage, all.length, pageSize);
  return { ...info, rows: all.slice(info.offset, info.offset + pageSize) };
}

/** Page numbers to show in the pager: first, last, and a window around the current page, with gaps as null. */
export function pageWindow(page: number, totalPages: number): Array<number | null> {
  const keep = new Set<number>([1, totalPages, page - 1, page, page + 1]);
  const nums = [...keep].filter((n) => n >= 1 && n <= totalPages).sort((a, b) => a - b);
  const out: Array<number | null> = [];
  nums.forEach((n, i) => {
    if (i > 0 && n - nums[i - 1] > 1) out.push(null);
    out.push(n);
  });
  return out;
}
