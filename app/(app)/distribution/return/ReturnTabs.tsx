"use client";

import { useState, type ReactNode } from "react";
import { tabClass, tabListClass } from "@/components/ui/styles";

interface Props {
  outCount: number;
  returnedCount: number;
  out: ReactNode;
  returned: ReactNode;
  /** Which tab to open first, so a refreshed or shared ?rpage=2 link lands on Returned. */
  initialTab?: "out" | "returned";
}

/** Same tabs as Receive: a returned bottle leaves "Still out" and shows up under "Returned". */
export function ReturnTabs({ outCount, returnedCount, out, returned, initialTab = "out" }: Props) {
  const [tab, setTab] = useState<"out" | "returned">(initialTab);

  return (
    <div className="flex flex-col gap-3">
      <div role="tablist" aria-label="Bottles" className={tabListClass}>
        <button
          type="button"
          role="tab"
          id="tab-out"
          aria-selected={tab === "out"}
          aria-controls="panel-out"
          onClick={() => setTab("out")}
          className={tabClass(tab === "out")}
        >
          Still out ({outCount})
        </button>
        <button
          type="button"
          role="tab"
          id="tab-returned"
          aria-selected={tab === "returned"}
          aria-controls="panel-returned"
          onClick={() => setTab("returned")}
          className={tabClass(tab === "returned")}
        >
          Returned ({returnedCount})
        </button>
      </div>

      {tab === "out" ? (
        <div role="tabpanel" id="panel-out" aria-labelledby="tab-out">
          {out}
        </div>
      ) : (
        <div role="tabpanel" id="panel-returned" aria-labelledby="tab-returned">
          {returned}
        </div>
      )}
    </div>
  );
}
