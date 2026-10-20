// The seam between the tracker and wherever Pharmacy data lives (architecture sections 9 and 16.2).
// Services only talk to this interface, so the CSV provider used now can be swapped for the EMR
// provider (Phase 7) without touching the reconcile rules.

export interface PharmacyGrnLine {
  grnRef: string;
  itemLabel: string;
  /** Generic and brand, normalised. */
  itemKey: string;
  batchNo: string;
  expiryDate: string | null;
  quantity: number;
  unitCost: string | null;
  unit: string | null;
  category: string | null;
  supplier: string | null;
  importedAt: Date;
}

export interface PharmacyBalance {
  /** The tracker location the stock was imported for. */
  locationId: string;
  itemLabel: string;
  batchNo: string;
  expiryDate: string | null;
  unitCost: string | null;
  quantity: number;
  importedAt: Date;
}

export interface PharmacyBatchInfo {
  batchNo: string;
  itemLabel: string;
  expiryDate: string | null;
  unitCost: string | null;
  /** Stock of this batch per location, as of each location's last inventory import. */
  balances: { locationId: string; quantity: number; importedAt: Date }[];
}

export interface PharmacyTransferInfo {
  /** The Pharmacy transfer id, when the export carried one. */
  ref: string | null;
  type: string | null;
  /** Where the stock came from and where it went (a "request" is already flipped). */
  fromLabel: string | null;
  toLabel: string | null;
  status: string | null;
  requestedBy: string | null;
  requestedAt: Date | null;
  quantity: number;
  lines: number | null;
}

export interface PharmacyProvider {
  /** Where batch and transfer links are marked as coming from. */
  readonly source: "manual" | "csv" | "emr";
  /** GRN lines, newest import first; one GRN when `grnRef` is given. */
  listGrns(grnRef?: string): Promise<PharmacyGrnLine[]>;
  /** One batch by its batch number, or null when the Pharmacy does not know it (or cannot say). */
  getBatch(batchNo: string): Promise<PharmacyBatchInfo | null>;
  /** One transfer by its Pharmacy transfer id, or null. */
  getTransfer(ref: string): Promise<PharmacyTransferInfo | null>;
  /** Stock on hand per location and batch; for one location when `locationId` is given. */
  getBalances(locationId?: string): Promise<PharmacyBalance[]>;
}
