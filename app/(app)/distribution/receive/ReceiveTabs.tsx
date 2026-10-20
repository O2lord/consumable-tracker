"use client";

import { useState, type ReactNode } from "react";
import { tabClass, tabListClass } from "@/components/ui/styles";

interface Props {
  pendingCount: number;
  receivedCount: number;
  pending: ReactNode;
  received: ReactNode;
  /** Which tab to open on first render, so a refreshed or shared ?rpage=2 link lands on Received. */
  initialTab?: "pending" | "received";
}

/** Side-by-side tabs: only the chosen list is shown at a time. */
export function ReceiveTabs({ pendingCount, receivedCount, pending, received, initialTab = "pending" }: Props) {
  const [tab, setTab] = useState<"pending" | "received">(initialTab);

  return (
    <div className="flex flex-col gap-3">
      <div role="tablist" aria-label="Transfers" className={tabListClass}>
        <button
          type="button"
          role="tab"
          id="tab-pending"
          aria-selected={tab === "pending"}
          aria-controls="panel-pending"
          onClick={() => setTab("pending")}
          className={tabClass(tab === "pending")}
        >
          Pending ({pendingCount})
        </button>
        <button
          type="button"
          role="tab"
          id="tab-received"
          aria-selected={tab === "received"}
          aria-controls="panel-received"
          onClick={() => setTab("received")}
          className={tabClass(tab === "received")}
        >
          Received ({receivedCount})
        </button>
      </div>

      {tab === "pending" ? (
        <div role="tabpanel" id="panel-pending" aria-labelledby="tab-pending">
          {pending}
        </div>
      ) : (
        <div role="tabpanel" id="panel-received" aria-labelledby="tab-received">
          {received}
        </div>
      )}
    </div>
  );
}
