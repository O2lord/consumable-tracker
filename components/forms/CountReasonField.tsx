"use client";

import { useState } from "react";
import { Select } from "../ui/Dropdown";
import { inputClass } from "../ui/styles";

/**
 * The reason picker for one difference on a stock count, with its note. The note box only appears when "Other" is
 * chosen, because only then is a note required. A note field is always sent (empty when hidden), so the form's
 * repeated reason and note lists stay lined up line by line.
 */
export function CountReasonField({
  reasonName,
  noteName,
  options,
  ariaLabel,
  placeholder,
  noteAriaLabel,
}: {
  reasonName: string;
  noteName: string;
  options: readonly { value: string; label: string }[];
  ariaLabel: string;
  placeholder: string;
  noteAriaLabel: string;
}) {
  const [reason, setReason] = useState("");

  return (
    <div className="flex min-w-[16rem] flex-col gap-1">
      <Select name={reasonName} ariaLabel={ariaLabel} placeholder={placeholder} options={options} onChange={setReason} />
      {reason === "OTHER" ? (
        <input
          name={noteName}
          maxLength={300}
          required
          placeholder="Explain the difference"
          aria-label={noteAriaLabel}
          className={inputClass}
        />
      ) : (
        <input type="hidden" name={noteName} value="" />
      )}
    </div>
  );
}
