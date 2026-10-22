"use client";

import { useState, type ReactNode } from "react";

/**
 * Two tabs for a batch page: the labels first, then where the batch went. The content of each tab is rendered on
 * the server and passed in, so this only switches which one is visible.
 */
export function BatchTabs({ labels, history }: { labels: ReactNode; history: ReactNode }) {
  const [active, setActive] = useState<"labels" | "history">("labels");

  const tabs: { id: "labels" | "history"; name: string }[] = [
    { id: "labels", name: "Labels" },
    { id: "history", name: "History" },
  ];

  return (
    <div className="flex flex-col gap-5">
      <div role="tablist" aria-label="Batch sections" className="flex gap-6 border-b border-line">
        {tabs.map((t) => {
          const selected = active === t.id;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`batch-tab-${t.id}`}
              aria-selected={selected}
              aria-controls={`batch-panel-${t.id}`}
              onClick={() => setActive(t.id)}
              className={`-mb-px border-b-2 px-1 pb-2.5 text-[15px] font-semibold transition-colors ${
                selected
                  ? "border-side-title text-side-title"
                  : "border-transparent text-muted hover:text-ink"
              }`}
            >
              {t.name}
            </button>
          );
        })}
      </div>

      <div
        role="tabpanel"
        id="batch-panel-labels"
        aria-labelledby="batch-tab-labels"
        hidden={active !== "labels"}
        className="flex flex-col gap-5"
      >
        {labels}
      </div>
      <div
        role="tabpanel"
        id="batch-panel-history"
        aria-labelledby="batch-tab-history"
        hidden={active !== "history"}
        className="flex flex-col gap-5"
      >
        {history}
      </div>
    </div>
  );
}
