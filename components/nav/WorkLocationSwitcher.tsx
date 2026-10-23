"use client";

import { useState, useTransition } from "react";
import { Select } from "@/components/ui/Dropdown";

interface Props {
  /** Active locations, for the list. Only used when the person may choose. */
  locations: { id: string; name: string }[];
  /** Where the person is working now (their home location until a supervisor or admin chooses another). */
  value: string | null;
  /** That location's name, even when it is no longer active and so not in the list. */
  currentName: string | null;
  /** Supervisors and admins (work_any_location) choose; everyone else sees their own location, read-only. */
  canChoose: boolean;
  /** Saves the choice on the server. The layout is refreshed, so every page and the extension follow. */
  setLocationAction: (locationId: string) => Promise<{ error?: string }>;
}

/**
 * "Working at": set once here and used on every page (Issue, Return, Void, Used for test, Stock...). Someone locked
 * to their home location sees it as plain text, so they always know where they are working.
 */
export function WorkLocationSwitcher({ locations, value, currentName, canChoose, setLocationAction }: Props) {
  const [picked, setPicked] = useState(value ?? "");
  const [seen, setSeen] = useState(value);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // Follow the server: after a switch (here or in another tab) the page comes back with the new value.
  if (seen !== value) {
    setSeen(value);
    setPicked(value ?? "");
  }

  if (!canChoose) {
    return (
      <div className="flex flex-col leading-tight" title="You work at your own location">
        <span className="text-xs font-normal text-muted">Working at</span>
        <span className="text-sm font-semibold">{currentName ?? "No location set"}</span>
      </div>
    );
  }

  function choose(id: string) {
    setPicked(id);
    setError(null);
    startTransition(async () => {
      const result = await setLocationAction(id);
      if (result.error) {
        setPicked(value ?? "");
        setError(result.error);
      }
    });
  }

  return (
    <div className={`flex flex-col gap-0.5 ${pending ? "opacity-60" : ""}`} aria-busy={pending}>
      <span className="text-xs font-normal text-muted">Working at</span>
      <div className="w-56 max-w-full">
        <Select
          name="workLocation"
          ariaLabel="Working at"
          value={picked}
          placeholder="Choose where you work"
          options={locations.map((l) => ({ value: l.id, label: l.name }))}
          onChange={choose}
        />
      </div>
      {error ? (
        <span role="alert" className="text-xs text-bad">
          {error}
        </span>
      ) : null}
    </div>
  );
}
