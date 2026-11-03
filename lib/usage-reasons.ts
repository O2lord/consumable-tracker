// Why part of a reagent container was used without being a patient test. When a container covers 100 tests and the lab
// did 90, the other 10 are accounted for with one of these reasons (10 for quality control, say). A fixed list, like
// void reasons, so reports can add them up. Shared by the Used for test form and the server.

export const USAGE_REASONS = [
  { code: "QUALITY_CONTROL", label: "Quality control" },
  { code: "CALIBRATION", label: "Calibration" },
  { code: "REPEAT_TEST", label: "Repeat or rerun" },
  { code: "SPILLAGE_WASTE", label: "Spillage or waste" },
  { code: "OTHER", label: "Other (say why in the note)" },
] as const;

export type UsageReasonCode = (typeof USAGE_REASONS)[number]["code"];

export const USAGE_REASON_CODES = USAGE_REASONS.map((r) => r.code) as [UsageReasonCode, ...UsageReasonCode[]];

export function usageReasonLabel(code: string | null | undefined): string {
  return USAGE_REASONS.find((r) => r.code === code)?.label ?? (code ?? "");
}
