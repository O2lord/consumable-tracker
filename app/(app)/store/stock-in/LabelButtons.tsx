import { SmartPrint } from "@/components/labels/SmartPrint";
import { linkButtonClass, primaryLinkButtonClass } from "@/components/ui/styles";

type Props = (
  | { batch: string; only: "batch" | "items" | "cartons" | "packs" | "bottles" }
  | { delivery: string; only: "delivery" | "batches" }
  // One carton: its own label, or only the packs or bottles inside it. Leave `only` out for all of them together.
  | { carton: string; only?: "carton" | "packs" | "bottles" }
  // One pack: its own label, or only the bottles inside it. Leave `only` out for both.
  | { pack: string; only?: "pack" | "bottles" }
) & {
  /** The button text. */
  label: string;
  /** One label, shown as a plain text link next to a title. Several labels open the preview, where you choose which. */
  single?: boolean;
  /** Stack the actions in a narrow column, for a side panel. */
  stacked?: boolean;
};

/**
 * Print buttons for one part of a delivery or batch. One label prints straight away: the PDF on a PC, or straight to
 * the USB printer on a phone or tablet (SmartPrint decides, so there is never a second button). Several labels open
 * the preview page, where you can print all of them or only some (the first 10 of 100, or labels 3-7), and which
 * does the same PC / phone switch. See docs/label-printing-setup.md.
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
      <SmartPrint
        pdfHref={`/api/labels?${q}&format=pdf`}
        tsplHref={`/api/labels?${q}&format=tspl`}
        className="text-sm font-semibold text-side-title underline"
      >
        {label}
      </SmartPrint>
    );
  }

  // Several labels: the preview page, where you choose all of them or only some, then print.
  const previewHref = `/api/labels?${q}&format=preview`;

  if (stacked) {
    return (
      <div className="flex flex-col gap-2">
        <a href={previewHref} target="_blank" rel="noreferrer" className={`${linkButtonClass} justify-center`}>
          {label}
        </a>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <a href={previewHref} target="_blank" rel="noreferrer" className={primaryLinkButtonClass}>
        {label}
      </a>
    </div>
  );
}
