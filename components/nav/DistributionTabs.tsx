"use client";

import { createContext, useContext, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { tabClass, tabListClass } from "@/components/ui/styles";

export interface DistributionTab {
  label: string;
  href: string;
}

const TabsContext = createContext<DistributionTab[]>([]);

/** Hands the tabs the person may use (worked out on the server) to the pages below, so a page header can place the strip. */
export function DistributionTabsProvider({ tabs, children }: { tabs: DistributionTab[]; children: ReactNode }) {
  return <TabsContext.Provider value={tabs}>{children}</TabsContext.Provider>;
}

/**
 * Issue, Used for test, Return and Void are one job (what happens to stock at a location after it arrives), so they
 * share one tab strip instead of four sidebar entries. Each page's header (title, intro, main button) renders first and
 * puts this strip right under it. It shows nothing anywhere else: outside those four pages, on a bottle's detail page,
 * or when the person may use fewer than two of them. Each tab is a link, so every tab keeps its own address and page.
 */
export function DistributionTabs() {
  const tabs = useContext(TabsContext);
  const pathname = usePathname();
  const here = tabs.find((t) => t.href === pathname);
  if (!here || tabs.length < 2) return null;

  return (
    <nav aria-label="Issue and return" className={tabListClass}>
      {tabs.map((t) => (
        <Link key={t.href} href={t.href} aria-current={t.href === here.href ? "page" : undefined} className={tabClass(t.href === here.href)}>
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
