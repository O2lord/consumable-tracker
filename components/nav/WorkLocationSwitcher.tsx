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

/** Map pin shown in place of the "Working at" label. Decorative: the control carries its own accessible name. */
function MapPinIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="h-4 w-4 shrink-0 text-muted"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 0 1 16 0Z" />
      <circle cx="12" cy="10" r="3" />
    </svg>
  );
}

/**
 * The work location: set once here and used on every page (Issue, Return, Void, Used for test, Stock...). Someone locked
 * to their home location sees it as plain text, so they always know where they are working. A map pin marks it.
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
      <div className="flex items-center gap-1.5" title="You work at your own location" aria-label={`Working at ${currentName ?? "no location set"}`}>
        <MapPinIcon />
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
      <div className="flex items-center gap-2">
        <span title="Working at">
          <MapPinIcon />
        </span>
        <div className="w-fit max-w-full">
          <Select
            name="workLocation"
            ariaLabel="Working at"
            value={picked}
            placeholder="Choose where you work"
            options={locations.map((l) => ({ value: l.id, label: l.name }))}
            onChange={choose}
          />
        </div>
      </div>
      {error ? (
        <span role="alert" className="text-xs text-bad">
          {error}
        </span>
      ) : null}
    </div>
  );
}
