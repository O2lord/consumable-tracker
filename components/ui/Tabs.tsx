"use client";

import { useState, type ReactNode } from "react";
import { tabClass, tabListClass } from "./styles";

export interface TabItem {
  id: string;
  label: string;
  count?: number;
  content: ReactNode;
}

/**
 * Only the chosen panel is shown. Look comes from styles.ts.
 * `initialId` is the tab to show until the person picks one themselves: it is read on every render, so a page that
 * refreshes with new counts (items scanned onto a draft) moves to the right tab. Once a tab is clicked, that choice stays.
 */
export function Tabs({ label, tabs, initialId }: { label: string; tabs: TabItem[]; initialId?: string }) {
  const [picked, setPicked] = useState<string | null>(null);
  const active = picked ?? initialId ?? tabs[0]?.id;

  return (
    <div className="flex flex-col gap-3">
      <div role="tablist" aria-label={label} className={tabListClass}>
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`tab-${t.id}`}
            aria-selected={active === t.id}
            aria-controls={`panel-${t.id}`}
            onClick={() => setPicked(t.id)}
            className={tabClass(active === t.id)}
          >
            {t.label}
            {t.count !== undefined ? ` (${t.count})` : ""}
          </button>
        ))}
      </div>
      {tabs.map((t) =>
        active === t.id ? (
          <div key={t.id} role="tabpanel" id={`panel-${t.id}`} aria-labelledby={`tab-${t.id}`}>
            {t.content}
          </div>
        ) : null,
      )}
    </div>
  );
}
