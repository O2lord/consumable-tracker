"use client";

import { useState, type ReactNode } from "react";
import { tabClass, tabListClass } from "@/components/ui/styles";

interface Props {
  draftCount: number;
  historyCount: number;
  drafts: ReactNode;
  history: ReactNode;
  /** Which tab to open on first render, so a refreshed or shared ?hpage=2 link lands on History. */
  initialTab?: "drafts" | "history";
}

/** Side-by-side tabs: only the chosen list is shown at a time. */
export function TransferTabs({ draftCount, historyCount, drafts, history, initialTab = "drafts" }: Props) {
  const [tab, setTab] = useState<"drafts" | "history">(initialTab);

  return (
    <div className="flex flex-col gap-3">
      <div role="tablist" aria-label="Transfers" className={tabListClass}>
        <button
          type="button"
          role="tab"
          id="tab-drafts"
          aria-selected={tab === "drafts"}
          aria-controls="panel-drafts"
          onClick={() => setTab("drafts")}
          className={tabClass(tab === "drafts")}
        >
          Drafts ({draftCount})
        </button>
        <button
          type="button"
          role="tab"
          id="tab-history"
          aria-selected={tab === "history"}
          aria-controls="panel-history"
          onClick={() => setTab("history")}
          className={tabClass(tab === "history")}
        >
          History ({historyCount})
        </button>
      </div>

      {tab === "drafts" ? (
        <div role="tabpanel" id="panel-drafts" aria-labelledby="tab-drafts">
          {drafts}
        </div>
      ) : (
        <div role="tabpanel" id="panel-history" aria-labelledby="tab-history">
          {history}
        </div>
      )}
    </div>
  );
}
