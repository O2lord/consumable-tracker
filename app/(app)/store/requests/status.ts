import type { Tone } from "@/components/ui/Tag";

export const STATUS_TONE: Record<string, Tone> = {
  DRAFT: "brand",
  SUBMITTED: "warn",
  APPROVED: "brand",
  PARTIALLY_FULFILLED: "warn",
  FULFILLED: "ok",
  REJECTED: "bad",
  CLOSED: "brand",
  CANCELLED: "bad",
};
