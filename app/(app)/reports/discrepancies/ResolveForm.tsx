"use client";

import { useState } from "react";
import { ActionForm } from "@/components/forms/ActionForm";
import { ScanField } from "@/components/scanner/ScanField";
import { Select } from "@/components/ui/Dropdown";
import { Field } from "@/components/ui/Field";
import { inputClass } from "@/components/ui/styles";
import { resolveDiscrepancyAction } from "./actions";

interface Props {
  transferItemId: string;
  /** A serialized bottle is always resolved one at a time; bulk items can be split. */
  isSerial: boolean;
  outstanding: number;
  /** The outstanding quantity is loose pieces, so "how many" is a number of pieces. */
  inPieces?: boolean;
  /** Where the transfer was going: a found unit goes back in stock here unless another place is chosen. */
  destinationName: string;
  /** Every other active location a found unit could turn up in. */
  otherLocations: { id: string; name: string }[];
}

/** The resolve step inside the Trace pop-up: outcome, where it was found, how many (bulk), and a reason. */
export function ResolveForm({ transferItemId, isSerial, outstanding, inPieces = false, destinationName, otherLocations }: Props) {
  const [outcome, setOutcome] = useState("");

  return (
    <ActionForm
      action={resolveDiscrepancyAction}
      submitLabel="Resolve"
      resetOnSuccess={false}
      className="flex flex-col gap-4"
    >
      <input type="hidden" name="transferItemId" value={transferItemId} />

      <Field label="What happened to it?">
        <Select
          name="resolution"
          ariaLabel="What happened to it?"
          required
          value={outcome}
          onChange={setOutcome}
          placeholder="Choose an outcome"
          options={[
            { value: "FOUND", label: "Found, back in stock" },
            { value: "WRITTEN_OFF", label: "Written off" },
          ]}
        />
      </Field>

      {outcome === "FOUND" ? (
        <Field label="Where was it found?" hint="It goes back in stock at this location.">
          <Select
            name="foundLocationId"
            ariaLabel="Where was it found?"
            defaultValue=""
            emptyLabel={`${destinationName} (where it was sent)`}
            options={otherLocations.map((l) => ({ value: l.id, label: l.name }))}
          />
        </Field>
      ) : null}

      {outcome === "FOUND" ? (
        <ScanField
          name="scannedCode"
          label={isSerial ? "Scan the bottle" : "Scan the box label"}
          hint={
            isSerial
              ? "Scan the bottle you found. It has to be the one that went missing."
              : "Scan the label on the box you found. It has to be the batch that was short."
          }
        />
      ) : null}

      {isSerial ? null : (
        <Field
          label={inPieces ? "How many pieces?" : "How many?"}
          hint={`${outstanding.toLocaleString("en-GB")}${inPieces ? " pieces" : ""} outstanding. You can resolve part of it now.`}
        >
          <input
            name="quantity"
            type="number"
            min={1}
            max={outstanding}
            step={1}
            defaultValue={outstanding}
            required
            className={`${inputClass} w-32`}
          />
        </Field>
      )}

      <Field label="Reason" hint="Kept in the record with your name.">
        <input name="note" required minLength={3} maxLength={500} placeholder="For example: found on the shelf in store" className={inputClass} />
      </Field>
    </ActionForm>
  );
}
