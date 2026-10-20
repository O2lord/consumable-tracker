"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/server/auth/session";
import {
  closeReceipt,
  countQuantity,
  getReceiptProgress,
  openReceipt,
  receivePack,
  receiveUnit,
} from "@/server/services/receive.service";
import type { ReceiptProgress } from "@/server/services/receive.service";
import { canWorkAtAnyLocation } from "@/server/auth/permissions";
import { toFormError } from "@/server/actions/form-result";
import { toScanError } from "@/server/actions/scan-result";
import { formDataToObject } from "@/lib/form";
import { canSwitchUnit, lineCountUnit, type CountUnit } from "@/lib/pack-size";
import type { FormState } from "@/components/forms/form-state";
import type { ScanResult } from "@/components/scanner/ScanSession";

const refresh = (code: string) => revalidatePath(`/distribution/receive/${code}`);

/**
 * What the receiving pop-up shows. Like the receive page, it never carries the dispatched quantity of a
 * bulk batch, so counts stay blind. Only the number counted so far is sent.
 */
export interface ReceiptView {
  transferId: string;
  code: string;
  serialExpected: number;
  serialScanned: number;
  /** How many bottles of each item are still unscanned. Never their codes, so they cannot be copied into the scan box. */
  unscannedByItem: { itemName: string; count: number }[];
  /** Some whole packs were scanned one by one when this transfer was sent, so their labels can be scanned in. */
  packsOnSlip: boolean;
  /** Packs scanned in so far. Never the number sent: counts stay blind. */
  packsReceived: number;
  /**
   * `inPieces`: sent as loose pieces. `canSwitch`: the receiver can count in packs or pieces, and `lineUnit` is the
   * unit the line was sent in (the default choice, and the unit `counted` is shown in).
   */
  quantityLines: {
    batchCode: string;
    itemName: string;
    counted: number | null;
    inPieces: boolean;
    canSwitch: boolean;
    lineUnit: CountUnit;
    /**
     * Every pack of this line was scanned when it was sent, so it is received by scanning each pack in. There is no
     * count to type: what is scanned is what arrived.
     */
    byScan: boolean;
    /** Packs of this line scanned in so far. Never the number sent: counts stay blind. */
    packsScanned: number;
  }[];
}

function toView(p: ReceiptProgress): ReceiptView {
  return {
    transferId: p.transferId,
    code: p.code,
    serialExpected: p.serialExpected,
    serialScanned: p.serialScanned,
    unscannedByItem: p.unscannedByItem,
    packsOnSlip: p.packsOnSlip,
    packsReceived: p.packsReceived,
    quantityLines: p.quantityLines.map((l) => ({
      batchCode: l.batchCode,
      itemName: l.itemName,
      counted: l.counted,
      inPieces: l.inPieces,
      canSwitch: canSwitchUnit(l.unit, l.packSize),
      lineUnit: lineCountUnit(l.unit, l.inPieces),
      byScan: l.byScan,
      packsScanned: l.packsScanned,
    })),
  };
}

export type OpenReceiptResult = ScanResult & { code?: string; view?: ReceiptView };

/** Scan of the transfer slip: opens the receipt (or resumes it) and returns what the pop-up needs to carry on. */
export async function openReceiptAction(value: string): Promise<OpenReceiptResult> {
  const session = await requirePermission("receive");
  try {
    const p = await openReceipt(value, session);
    revalidatePath("/distribution/receive");
    return { kind: "ok", message: `Receipt open for ${p.code}`, code: p.code, view: toView(p) };
  } catch (err) {
    return toScanError(err);
  }
}

/** Fresh progress for the receiving pop-up after a scan or a count. Null if it is not this person's to see. */
export async function getReceiptViewAction(transferId: string): Promise<ReceiptView | null> {
  const session = await requirePermission("receive");
  try {
    const p = await getReceiptProgress(transferId);
    if (!canWorkAtAnyLocation(session.role) && p.toLocationId !== session.homeLocationId) return null;
    return toView(p);
  } catch {
    return null;
  }
}

/** One bottle scanned at the destination. Repeats are reported, not counted twice. */
export async function receiveUnitAction(transferId: string, code: string, value: string): Promise<ScanResult> {
  const session = await requirePermission("receive");
  try {
    const r = await receiveUnit(transferId, value, session);
    refresh(code);
    if (r.status === "duplicate") {
      return { kind: "duplicate", message: `${r.serial} was already scanned (${r.scanned} of ${r.expected})` };
    }
    return { kind: "ok", message: `${r.serial}, ${r.itemName} (${r.scanned} of ${r.expected})` };
  } catch (err) {
    return toScanError(err);
  }
}

/** One whole pack or roll scanned at the destination: its location moves here. Repeats are reported, not counted twice. */
export async function receivePackAction(transferId: string, code: string, value: string): Promise<ScanResult> {
  const session = await requirePermission("receive");
  try {
    const r = await receivePack(transferId, value, session);
    refresh(code);
    if (r.status === "duplicate") {
      return { kind: "duplicate", message: `${r.packCode} was already scanned in (${r.received} packs so far)` };
    }
    return { kind: "ok", message: `${r.packCode}, ${r.itemName} (${r.received} ${r.received === 1 ? "pack" : "packs"} scanned in)` };
  } catch (err) {
    return toScanError(err);
  }
}

/** Blind count of a bulk batch. Entering it again replaces the earlier count until the receipt closes. */
export async function countQuantityAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const session = await requirePermission("receive");
  const raw = formDataToObject(formData);
  const code = String(raw.code ?? "");
  const batch = String(raw.batch ?? "");
  if (!batch) return { error: "Scan or type the batch code from the box label" };
  if (raw.counted === undefined) return { error: "Enter how many you counted (0 if none arrived)" };
  const counted = Number(raw.counted);
  // Packs or pieces, as the receiver chose. Anything else is ignored and the count is taken in the line's own unit.
  const countedIn: CountUnit | undefined = raw.countedIn === "pack" || raw.countedIn === "pieces" ? raw.countedIn : undefined;
  try {
    const r = await countQuantity(String(raw.transferId ?? ""), batch, counted, session, undefined, { countedIn });
    refresh(code);
    return { message: `Counted ${r.counted} of ${r.itemName} (${r.batchCode})` };
  } catch (err) {
    return toFormError(err);
  }
}

/** Closes the receipt: unscanned bottles and short counts become discrepancies. */
export async function closeReceiptAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const session = await requirePermission("receive");
  const raw = formDataToObject(formData);
  const code = String(raw.code ?? "");
  try {
    const { outcome } = await closeReceipt(String(raw.transferId ?? ""), session);
    refresh(code);
    revalidatePath("/distribution/receive");
    return outcome.hasDiscrepancy
      ? {
          message: `Receipt closed with a discrepancy: ${outcome.missingSerials.length} bottle(s) and ${outcome.shortfalls.length} batch shortfall(s) reported.`,
        }
      : { message: "Receipt closed. Everything is accounted for." };
  } catch (err) {
    return toFormError(err);
  }
}
