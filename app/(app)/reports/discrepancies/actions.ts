"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/server/auth/session";
import { can } from "@/server/auth/permissions";
import { getTransferPeople, listOpenDiscrepancies, resolveDiscrepancy } from "@/server/services/discrepancy.service";
import { getUnitWithHistory } from "@/server/services/unit.service";
import { toFormError } from "@/server/actions/form-result";
import { formDataToObject } from "@/lib/form";
import type { FormState } from "@/components/forms/form-state";
import type { ResolveDiscrepancyInput } from "@/types/transfers";

/** One line of the timeline in the Trace pop-up. Dates travel as ISO text. */
export interface TraceStep {
  label: string;
  place: string;
  /** Null when the person's role may not see who was involved. */
  who: string | null;
  at: string | null;
  note: string | null;
}

export interface TraceView {
  steps: TraceStep[];
  /** Who dispatched, carried, opened and closed the receipt for the whole transfer. Empty when names are hidden. */
  handover: TraceStep[];
  /** True when names were left out because the role lacks `view_discrepancy_people`. */
  namesHidden: boolean;
}

function eventLabel(type: string): string {
  if (type === "RETURNED") return "Returned (used)";
  if (type === "RETURNED_UNUSED") return "Returned (unused)";
  const text = type.toLowerCase().replace(/_/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * The timeline for one open discrepancy. A missing bottle shows everything recorded about it, oldest
 * first. A bulk batch has no per-unit events, so it shows who dispatched, opened and closed the transfer.
 * Only items that are open discrepancies can be traced here, and names need `view_discrepancy_people`.
 */
export async function getTraceAction(transferId: string, serial: string | null): Promise<TraceView | null> {
  const session = await requirePermission("view_discrepancies");
  const canPeople = can(session.role, "view_discrepancy_people");
  try {
    const open = await listOpenDiscrepancies();
    const row = open.find((r) => r.transferId === transferId && (serial ? r.serial === serial : r.serial === null));
    if (!row) return null;

    if (serial) {
      const found = await getUnitWithHistory(serial);
      if (!found) return null;
      const people = canPeople ? (await getTransferPeople([transferId])).get(transferId) : undefined;
      const handover: TraceStep[] = people
        ? [
            { label: "Dispatched", place: row.fromLocationName, who: people.dispatchedBy, at: people.dispatchedAt?.toISOString() ?? null, note: null },
            // Typed by the store keeper at dispatch. Transfers sent before it was recorded show "Not recorded".
            { label: "Carried by", place: "", who: people.carriedBy ?? (people.dispatchedBy ? "Not recorded" : null), at: null, note: null },
            { label: "Receipt opened", place: row.toLocationName, who: people.receivedBy, at: people.receiptStartedAt?.toISOString() ?? null, note: null },
            { label: "Receipt closed", place: row.toLocationName, who: people.receiptClosedBy, at: people.receiptClosedAt?.toISOString() ?? null, note: null },
          ].filter((s) => s.who)
        : [];
      const steps: TraceStep[] = found.history.slice(-40).map((h) => ({
        label: eventLabel(h.type),
        place: h.locationName,
        who: canPeople ? h.userName : null,
        at: h.occurredAt.toISOString(),
        note: [h.transferCode ? `Transfer ${h.transferCode}` : "", h.note ?? ""].filter(Boolean).join(". ") || null,
      }));
      return { steps, handover, namesHidden: !canPeople };
    }

    if (!canPeople) return { steps: [], handover: [], namesHidden: true };
    const p = (await getTransferPeople([transferId])).get(transferId);
    if (!p) return { steps: [], handover: [], namesHidden: false };
    const all: TraceStep[] = [
      { label: "Dispatched", place: row.fromLocationName, who: p.dispatchedBy, at: p.dispatchedAt?.toISOString() ?? null, note: null },
      { label: "Carried by", place: "", who: p.carriedBy ?? (p.dispatchedBy ? "Not recorded" : null), at: null, note: null },
      { label: "Receipt opened", place: row.toLocationName, who: p.receivedBy, at: p.receiptStartedAt?.toISOString() ?? null, note: null },
      { label: "Receipt closed", place: row.toLocationName, who: p.receiptClosedBy, at: p.receiptClosedAt?.toISOString() ?? null, note: "Counted short, reported missing" },
    ];
    // A bulk batch has no per-unit events, so its timeline already is the handover trail.
    return { steps: all.filter((s) => s.who), handover: [], namesHidden: false };
  } catch {
    return null;
  }
}

/** A supervisor marks some or all of a missing item as found or written off, with a reason. */
export async function resolveDiscrepancyAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const session = await requirePermission("resolve_discrepancy");
  const raw = formDataToObject(formData);
  try {
    const r = await resolveDiscrepancy(
      {
        transferItemId: String(raw.transferItemId ?? ""),
        // Not narrowed on purpose: the service validates it, so a missing choice is rejected, not guessed.
        resolution: raw.resolution as ResolveDiscrepancyInput["resolution"],
        quantity: raw.quantity === undefined ? 1 : Number(raw.quantity),
        foundLocationId: raw.foundLocationId ? String(raw.foundLocationId) : undefined,
        scannedCode: raw.scannedCode ? String(raw.scannedCode) : undefined,
        note: raw.note === undefined ? "" : String(raw.note),
      },
      session.userId,
    );
    revalidatePath("/reports/discrepancies");
    revalidatePath("/dashboard");
    return {
      message:
        r.remainingOnTransfer === 0
          ? `Resolved. ${r.transferCode} has no open discrepancies left.`
          : `Resolved. ${r.remainingOnTransfer} item(s) on ${r.transferCode} still open.`,
    };
  } catch (err) {
    return toFormError(err);
  }
}
