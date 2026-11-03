import { linkButtonClass, primaryLinkButtonClass } from "@/components/ui/styles";
import { UsbPrintButton } from "./UsbPrintButton";

type Props = (
  | { batch: string; only: "batch" | "items" | "cartons" | "packs" | "bottles" }
  | { delivery: string; only: "delivery" | "batches" }
  // One carton: its own label, or only the packs or bottles inside it. Leave `only` out for all of them together.
  | { carton: string; only?: "carton" | "packs" | "bottles" }
  // One pack: its own label, or only the bottles inside it. Leave `only` out for both.
  | { pack: string; only?: "pack" | "bottles" }
) & {
  /** For a single label this is the link text. Several labels get the full PDF button. */
  label: string;
  /** One label, shown as a plain text link next to a title. Several labels get the full set of buttons. */
  single?: boolean;
  /** Stack the actions in a narrow column (a single Open batch label button), for a side panel. */
  stacked?: boolean;
};

/**
 * Buttons for one part of a delivery or batch: open the label PDF (staff check it, then print it with the system
 * print window, see docs/label-printing-setup.md). Nothing is installed on the PC
 * besides the printer's driver. Each part is its own action.
 */
export function LabelButtons(props: Props) {
  const { label, single = false, stacked = false, only } = props;
  const target =
    "batch" in props
      ? `batch=${encodeURIComponent(props.batch)}`
      : "carton" in props
        ? `carton=${encodeURIComponent(props.carton)}`
        : "pack" in props
          ? `pack=${encodeURIComponent(props.pack)}`
          : `delivery=${encodeURIComponent(props.delivery)}`;
  const q = only ? `${target}&only=${only}` : target;

  if (single) {
    // A single plain text link, not a button: it sits next to the page title.
    return (
      <span className="inline-flex items-start gap-3">
        <a
          href={`/api/labels?${q}&format=pdf`}
          target="_blank"
          rel="noreferrer"
          className="text-sm font-semibold text-side-title underline"
        >
          {label}
        </a>
        <UsbPrintButton query={q} className="text-sm font-semibold text-side-title underline">
          Print (USB)
        </UsbPrintButton>
      </span>
    );
  }

  if (stacked) {
    return (
      <div className="flex flex-col gap-2">
        <a
          href={`/api/labels?${q}&format=pdf`}
          target="_blank"
          rel="noreferrer"
          className={`${linkButtonClass} justify-center`}
        >
          Open batch label
        </a>
        <UsbPrintButton query={q} className={`${linkButtonClass} justify-center`}>
          Print label (USB)
        </UsbPrintButton>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <a href={`/api/labels?${q}&format=pdf`} target="_blank" rel="noreferrer" className={primaryLinkButtonClass}>
        Open PDF (one label per page)
      </a>
      <UsbPrintButton query={q} className={linkButtonClass}>
        Print labels (USB)
      </UsbPrintButton>
    </div>
  );
}
