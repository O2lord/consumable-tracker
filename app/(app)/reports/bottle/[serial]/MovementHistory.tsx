"use client";

import { useState, type ReactNode } from "react";

type View = "timeline" | "table";

function SwitchIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M7 4 3 8l4 4" />
      <path d="M3 8h14" />
      <path d="m17 12 4 4-4 4" />
      <path d="M21 16H7" />
    </svg>
  );
}

/** "Movement history" heading with a small switch button right after it; opens on the timeline. */
export function MovementHistory({ timeline, table }: { timeline: ReactNode; table: ReactNode }) {
  const [view, setView] = useState<View>("timeline");
  const next: View = view === "timeline" ? "table" : "timeline";
  const label = `Switch to ${next} view`;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-1.5">
        <h2 className="font-medium">Movement history</h2>
        <button
          type="button"
          onClick={() => setView(next)}
          aria-label={label}
          title={label}
          className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-line bg-surface text-ink hover:bg-brand-soft"
        >
          <SwitchIcon />
        </button>
      </div>
      {view === "timeline" ? timeline : table}
    </div>
  );
}
