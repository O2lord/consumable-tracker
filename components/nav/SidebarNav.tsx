"use client";

import { createContext, useContext, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

export interface SidebarLink {
  label: string;
  href: string;
}

export interface SidebarGroup {
  title: string;
  items: SidebarLink[];
}

/** The product name at the top of the sidebar. Also used as the loading placeholder. */
export function SidebarBrand() {
  return (
    <Link href="/dashboard" className="px-2.5 py-0.5 text-base leading-normal font-bold text-side-title">
      Consumables Tracker
    </Link>
  );
}

/**
 * Left-hand navigation. It is a client component only so it can highlight the current page and,
 * on narrow screens, fold away behind a Menu button.
 */
export function SidebarNav({ groups }: { groups: SidebarGroup[] }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  // Titles of the sections the user has folded away. Everything starts expanded.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const isActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`);

  // Navigating to a page (by link, back button, etc.) always reveals the section it lives in.
  useEffect(() => {
    const current = groups.find((g) => g.items.some((item) => isActive(item.href)));
    if (!current) return;
    setCollapsed((prev) => {
      if (!prev.has(current.title)) return prev;
      const next = new Set(prev);
      next.delete(current.title);
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  const toggle = (title: string) => setCollapsed((prev) => { const next = new Set(prev); if (next.has(title)) next.delete(title); else next.add(title); return next; });

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between gap-2 md:pb-3.5">
        <SidebarBrand />
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls="sidebar-links"
          className="rounded-lg border border-side-line bg-surface px-3 py-1 text-sm font-medium text-side-ink md:hidden"
        >
          {open ? "Close" : "Menu"}
        </button>
      </div>

      <nav
        id="sidebar-links"
        aria-label="Main"
        className={`${open ? "flex" : "hidden"} flex-col gap-0.5 md:flex`}
        onClick={() => setOpen(false)}
      >
        {groups.map((group) => {
          const isCollapsed = collapsed.has(group.title);
          const listId = `sidebar-group-${group.title.toLowerCase().replace(/\s+/g, "-")}`;
          return (
          <div key={group.title} className="flex flex-col gap-0.5">
            <button
              type="button"
              onClick={(e) => {
                // Folding a section must not close the mobile menu (the nav's own onClick does that).
                e.stopPropagation();
                toggle(group.title);
              }}
              aria-expanded={!isCollapsed}
              aria-controls={listId}
              className="mx-2.5 mb-1 flex items-center justify-between border-b border-side-line pt-4 pb-1.5 text-left text-base leading-normal font-semibold text-side-muted hover:text-side-ink"
            >
              <span>{group.title}</span>
              <svg
                width="14"
                height="14"
                viewBox="0 0 20 20"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
                className={`transition-transform ${isCollapsed ? "-rotate-90" : ""}`}
              >
                <path d="M5 8l5 5 5-5" />
              </svg>
            </button>
            <div id={listId} className={`${isCollapsed ? "hidden" : "flex"} flex-col gap-0.5`}>
            {group.items.map((item) => {
              const active = isActive(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={
                    active
                      ? "rounded-lg border-l-[3px] border-side-on-edge bg-side-on px-2.5 py-[7px] text-sm leading-normal font-semibold text-side-on-ink"
                      : "rounded-lg border-l-[3px] border-transparent px-2.5 py-[7px] text-sm leading-normal text-side-ink hover:bg-side-line/60"
                  }
                >
                  {item.label}
                </Link>
              );
            })}
            </div>
          </div>
          );
        })}
      </nav>
    </div>
  );
}

const SIDEBAR_KEY = "sidebar-collapsed";
const SidebarContext = createContext<{ collapsed: boolean; toggle: () => void }>({ collapsed: false, toggle: () => {} });

/**
 * Wraps the whole app frame so the sidebar can be hidden on desktop and brought back with the
 * button in the top bar (SidebarToggle). The choice is remembered in this browser. On narrow
 * screens the sidebar keeps its own Menu button and this has no effect.
 */
export function SidebarFrame({ sidebar, children }: { sidebar: React.ReactNode; children: React.ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    try {
      if (localStorage.getItem(SIDEBAR_KEY) === "1") setCollapsed(true);
    } catch {
      // Storage can be blocked; the sidebar just starts open.
    }
  }, []);

  const toggle = () =>
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(SIDEBAR_KEY, next ? "1" : "0");
      } catch {
        // ignore
      }
      return next;
    });

  return (
    <SidebarContext.Provider value={{ collapsed, toggle }}>
      <div className="flex min-h-screen flex-col md:flex-row">
        <aside
          id="app-sidebar"
          className={`border-b border-side-line bg-side p-3 md:sticky md:top-0 md:h-screen md:w-52 md:shrink-0 md:overflow-y-auto md:border-r md:border-b-0 md:p-3 md:pt-[18px] ${collapsed ? "md:hidden" : ""}`}
        >
          {sidebar}
        </aside>
        {children}
      </div>
    </SidebarContext.Provider>
  );
}

/** Desktop-only button that hides or shows the whole sidebar. Place it in the top bar. */
export function SidebarToggle() {
  const { collapsed, toggle } = useContext(SidebarContext);
  return (
    <button
      type="button"
      onClick={toggle}
      aria-expanded={!collapsed}
      aria-controls="app-sidebar"
      aria-label={collapsed ? "Show sidebar" : "Hide sidebar"}
      title={collapsed ? "Show sidebar" : "Hide sidebar"}
      className="hidden rounded-lg border border-side-line bg-surface p-1.5 text-side-ink hover:bg-side-line/60 md:inline-flex"
    >
      <svg
        width="18"
        height="18"
        viewBox="0 0 20 20"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <rect x="3" y="4" width="14" height="12" rx="2" />
        <path d="M8 4v12" />
      </svg>
    </button>
  );
}
