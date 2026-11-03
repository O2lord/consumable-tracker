"use client";

import { useEffect, useRef, useState } from "react";
import { ActionForm } from "@/components/forms/ActionForm";
import { Field } from "@/components/ui/Field";
import { calloutClass, inputClass, warnCalloutClass } from "@/components/ui/styles";
import { formatDay } from "@/lib/dashboard";
import { previewConversionAction, recordConversionAction, type PreviewResult } from "./actions";

export interface RecipeOption {
  id: string;
  name: string;
  inputItemTypeId: string;
  inputItemName: string;
  outputItemName: string;
  inputAmount: number;
  outputAmount: number;
  measureLabel: string;
  shelfLifeDays: number | null;
}

interface Props {
  workLocationId: string;
  recipes: RecipeOption[];
  /** `{ [itemTypeId]: { [locationId]: available } }`, in each recipe's measure. A missing entry is zero. */
  availability: Record<string, Record<string, number>>;
}

const n = (v: number) => v.toLocaleString("en-GB");

/**
 * The New conversion pop-up. The scientist picks a recipe and types how much to take; the screen asks the server what
 * that would make and shows the amount made, the expiry and the label code before anything is saved. None of those can
 * be edited. The Convert button stays off until the preview on screen matches what is typed, so the amount shown is
 * always the amount recorded (the server works it out again when it saves).
 */
export function ConversionForm({ workLocationId, recipes, availability }: Props) {
  const [recipeId, setRecipeId] = useState(recipes.length === 1 ? recipes[0].id : "");
  const [quantity, setQuantity] = useState("");
  const [shown, setShown] = useState<{ key: string; result: PreviewResult } | null>(null);
  // Only the newest request may update the screen, so a slow answer for an older amount never shows.
  const newest = useRef(0);

  const recipe = recipes.find((r) => r.id === recipeId);
  const amount = Number(quantity);
  const validAmount = quantity.trim() !== "" && Number.isInteger(amount) && amount >= 1;
  const key = recipe && validAmount ? `${recipe.id}|${amount}` : null;

  useEffect(() => {
    if (!key) return;
    const ticket = ++newest.current;
    const [id, qty] = key.split("|");
    const timer = setTimeout(async () => {
      let result: PreviewResult;
      try {
        result = await previewConversionAction({ recipeId: id, inputQuantity: qty, locationId: workLocationId });
      } catch {
        result = { ok: false, error: "Could not check this just now. Check your connection and try again." };
      }
      if (ticket === newest.current) setShown({ key, result });
    }, 350);
    return () => clearTimeout(timer);
  }, [key, workLocationId]);

  const current = key !== null && shown?.key === key ? shown.result : null;
  const checking = key !== null && current === null;
  const preview = current?.ok ? current.preview : null;
  const onShelf = recipe ? (availability[recipe.inputItemTypeId]?.[workLocationId] ?? 0) : 0;

  return (
    <ActionForm
      action={recordConversionAction}
      submitLabel="Convert"
      disabled={!preview}
      busyText="Recording the conversion..."
    >
      <input type="hidden" name="locationId" value={workLocationId} />
      {/* The code the preview showed, sent back so the label the scientist saw is the one recorded. */}
      <input type="hidden" name="code" value={preview?.code ?? ""} />

      <Field label="Recipe" required>
        <select
          name="recipeId"
          required
          value={recipeId}
          onChange={(e) => setRecipeId(e.target.value)}
          className={inputClass}
        >
          <option value="" disabled>
            Choose a recipe
          </option>
          {recipes.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
      </Field>

      {recipe ? (
        <p className="text-sm text-zinc-500">
          Takes {recipe.inputItemName}, makes {recipe.outputItemName} at {n(recipe.inputAmount)} : {n(recipe.outputAmount)}{" "}
          {recipe.measureLabel}.{" "}
          {recipe.shelfLifeDays === null ? "The result does not expire." : `The result keeps for ${n(recipe.shelfLifeDays)} days.`}{" "}
          On the shelf here: {n(onShelf)} {recipe.measureLabel}.
        </p>
      ) : null}

      <Field
        label={recipe ? `Amount to take (${recipe.measureLabel})` : "Amount to take"}
        hint="Whole numbers only. What it makes is worked out for you."
        required
      >
        <input
          name="inputQuantity"
          type="number"
          inputMode="numeric"
          min={1}
          step={1}
          required
          value={quantity}
          onChange={(e) => setQuantity(e.target.value)}
          className={inputClass}
          disabled={!recipe}
        />
      </Field>

      {checking ? (
        <p role="status" className="text-sm text-zinc-500">
          Checking the shelf...
        </p>
      ) : null}

      {current && !current.ok ? (
        <p role="alert" className={warnCalloutClass}>
          {current.error}
        </p>
      ) : null}

      {preview ? (
        <div className={`${calloutClass} flex flex-col gap-1`} aria-live="polite">
          <p>
            Uses{" "}
            <strong>
              {n(preview.inputQuantity)} {preview.measureLabel}
            </strong>{" "}
            of {preview.inputItemName}
          </p>
          <p>
            Makes{" "}
            <strong>
              {n(preview.outputQuantity)} {preview.measureLabel}
            </strong>{" "}
            of {preview.outputItemName}
          </p>
          <p>{preview.expiryDate ? `Expires ${formatDay(preview.expiryDate)}` : "Does not expire"}</p>
          <p>
            Label code <span className="font-mono">{preview.code}</span>
          </p>
        </div>
      ) : null}

      <Field label="Note (optional)">
        <input name="note" maxLength={200} className={inputClass} />
      </Field>
    </ActionForm>
  );
}
