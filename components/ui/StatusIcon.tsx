import type { ReactNode } from "react";
import { TRANSFER_STATUS_LABEL } from "@/types/transfers";

interface Look {
  color: string;
  strokeWidth: number;
  spin?: boolean;
  paths: ReactNode;
}

const LOOKS: Record<string, Look> = {
  // Pencil
  DRAFT: {
    color: "text-zinc-500",
    strokeWidth: 2,
    paths: (
      <>
        <path d="M12 20h9" />
        <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z" />
      </>
    ),
  },
  // Truck
  DISPATCHED: {
    color: "text-blue-600",
    strokeWidth: 2,
    paths: (
      <>
        <path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2" />
        <path d="M15 18H9" />
        <path d="M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.624l-3.48-4.35A1 1 0 0 0 17.52 8H14" />
        <circle cx="17" cy="18" r="2" />
        <circle cx="7" cy="18" r="2" />
      </>
    ),
  },
  // Spinner
  RECEIVING: {
    color: "text-amber-500",
    strokeWidth: 2.5,
    spin: true,
    paths: <path d="M21 12a9 9 0 1 1-6.219-8.56" />,
  },
  // Check mark
  RECEIVED: {
    color: "text-ok",
    strokeWidth: 3,
    paths: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  },
  // Warning triangle with "!"
  RECEIVED_WITH_DISCREPANCY: {
    color: "text-orange-500",
    strokeWidth: 2,
    paths: (
      <>
        <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
        <path d="M12 9v4" />
        <path d="M12 17h.01" />
      </>
    ),
  },
  // Check inside a circle
  DISCREPANCY_RESOLVED: {
    color: "text-teal-600",
    strokeWidth: 2,
    paths: (
      <>
        <circle cx="12" cy="12" r="10" />
        <path d="m9 12 2 2 4-4" />
      </>
    ),
  },
  // X
  CANCELLED: {
    color: "text-red-600",
    strokeWidth: 3,
    paths: (
      <>
        <path d="M18 6 6 18" />
        <path d="m6 6 12 12" />
      </>
    ),
  },
};

/**
 * A small icon for a transfer's status, coloured to match its meaning. The status wording is the
 * hover tip and the accessible name, so the meaning never rests on colour or shape alone.
 * Renders nothing for a status it does not know.
 */
export function StatusIcon({ status, className = "h-6 w-6" }: { status: string; className?: string }) {
  const look = LOOKS[status];
  if (!look) return null;
  const label = TRANSFER_STATUS_LABEL[status] ?? status;
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox="0 0 24 24"
      className={`${className} shrink-0 ${look.color} ${look.spin ? "animate-spin" : ""}`}
      fill="none"
      stroke="currentColor"
      strokeWidth={look.strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <title>{label}</title>
      {look.paths}
    </svg>
  );
}
