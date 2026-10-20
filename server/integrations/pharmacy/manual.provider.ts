import type { PharmacyProvider } from "./provider";

// Used when no Pharmacy data is loaded or wanted (PHARMACY_PROVIDER=manual): it never knows anything,
// so quantities are only ever checked by hand. Mirrors the manual reference provider.
export const manualPharmacyProvider: PharmacyProvider = {
  source: "manual",
  async listGrns() {
    return [];
  },
  async getBatch() {
    return null;
  },
  async getTransfer() {
    return null;
  },
  async getBalances() {
    return [];
  },
};
