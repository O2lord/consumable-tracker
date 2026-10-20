"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { Select } from "@/components/ui/Dropdown";

type Option = { value: string; label: string };

/** Switches the stock page to the chosen location as soon as it is picked, so no "Show" button is needed. */
export function LocationPicker({ options, value }: { options: Option[]; value: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <div className={`flex max-w-xs flex-col gap-1 text-sm font-medium ${pending ? "opacity-60" : ""}`} aria-busy={pending}>
      <span>Location</span>
      <Select
        name="location"
        ariaLabel="Location"
        defaultValue={value}
        options={options}
        onChange={(next) =>
          startTransition(() => router.push(`/distribution/stock?location=${encodeURIComponent(next)}`))
        }
      />
    </div>
  );
}
