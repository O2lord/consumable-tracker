// What a dispatch scan sends back to the screen. A scanned box (BT...) returns `batch`, which becomes
// the active batch; a scanned bottle (CT...) returns `batchCount` when it was scanned under a box.

import type { ScanResult } from "@/components/scanner/ScanSession";
import type { DispatchBatchInfo } from "@/server/services/transfer.service";

export type { DispatchBatchInfo };

export interface DispatchScanResult extends ScanResult {
  /** Set when the scan was a box label. */
  batch?: DispatchBatchInfo;
  /** Bottles of the active batch on the draft after this scan. */
  batchCount?: number;
}
