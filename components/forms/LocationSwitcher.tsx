"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { Select } from "@/components/ui/Dropdown";

type Option = { value: string; label: string };

/**
 * Switches a page to the chosen location as soon as it is picked. `basePath` is the page to go to and
 * `extraParams` are kept in the address (for example a date range), so no "Show" button is needed.
 */
export function LocationSwitcher({
  options,
  value,
  basePath,
  extraParams,
  label = "Location",
  allowNone,
}: {
  options: Option[];
  value: string;
  basePath: string;
  extraParams?: Record<string, string | undefined>;
  label?: string;
  /** Adds an "All locations" choice that clears the location from the address. */
  allowNone?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const go = (next: string) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(extraParams ?? {})) if (v) params.set(k, v);
    if (next) params.set("location", next);
    const query = params.toString();
    startTransition(() => router.push(query ? `${basePath}?${query}` : basePath));
  };

  return (
    <div className={`flex max-w-xs flex-col gap-1 text-sm font-medium ${pending ? "opacity-60" : ""}`} aria-busy={pending}>
      <span>{label}</span>
      <Select
        name="location"
        ariaLabel={label}
        defaultValue={value}
        options={allowNone ? [{ value: "", label: allowNone }, ...options] : options}
        onChange={go}
      />
    </div>
  );
}
