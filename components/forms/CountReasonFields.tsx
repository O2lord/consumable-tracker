"use client";

import { useState } from "react";
import { Select } from "@/components/ui/Dropdown";
import { inputClass } from "@/components/ui/styles";

/**
 * The reason picker for one count difference. The note box only appears once "Other" is chosen; for every
 * other reason a hidden empty field is still sent, so the reason and note lists stay lined up per line.
 */
export function CountReasonFields({
  reasonName,
  noteName,
  options,
  placeholder,
  reasonAriaLabel,
  noteAriaLabel,
}: {
  reasonName: string;
  noteName: string;
  options: { value: string; label: string }[];
  placeholder: string;
  reasonAriaLabel: string;
  noteAriaLabel: string;
}) {
  const [reason, setReason] = useState("");

  return (
    <div className="flex min-w-[16rem] flex-col gap-1">
      <Select
        name={reasonName}
        ariaLabel={reasonAriaLabel}
        placeholder={placeholder}
        options={options}
        onChange={setReason}
      />
      {reason === "OTHER" ? (
        <input
          name={noteName}
          maxLength={300}
          required
          minLength={3}
          placeholder="Note (required for Other)"
          aria-label={noteAriaLabel}
          className={inputClass}
        />
      ) : (
        <input type="hidden" name={noteName} value="" />
      )}
    </div>
  );
}
