import "server-only";
import { DomainError } from "../domain/errors";
import type { ScanResult } from "../../components/scanner/ScanSession";

/** Turns anything a service throws into a scan-screen message. Unknown errors are logged, not shown. */
export function toScanError(err: unknown): ScanResult {
  if (err instanceof DomainError) return { kind: "error", message: err.message };
  console.error(err);
  return { kind: "error", message: "Something went wrong. That scan was not saved. Scan it again" };
}
