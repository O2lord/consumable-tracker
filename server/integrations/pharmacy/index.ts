import { env } from "../../env";
import { csvPharmacyProvider } from "./csv.provider";
import { manualPharmacyProvider } from "./manual.provider";
import type { PharmacyProvider } from "./provider";

export type {
  PharmacyBalance,
  PharmacyBatchInfo,
  PharmacyGrnLine,
  PharmacyProvider,
  PharmacyTransferInfo,
} from "./provider";

/**
 * The provider in use, chosen by PHARMACY_PROVIDER (default `csv`): answers come from the imported
 * Pharmacy exports, and with nothing imported it knows nothing, exactly like `manual`. Phase 7 adds the
 * EMR provider here; this is the one switch.
 */
export function pharmacyProvider(): PharmacyProvider {
  return env().PHARMACY_PROVIDER === "manual" ? manualPharmacyProvider : csvPharmacyProvider;
}
