import { primaryLinkButtonClass } from "@/components/ui/styles";
import { PrintButton } from "./[batchCode]/PrintButton";

type Props = (
  | { batch: string; only: "batch" | "items" }
  | { delivery: string; only: "delivery" | "batches" }
) & {
  /** For a single label this is the link text. Several labels get the full PDF button. */
  label: string;
  /** One label, shown as a plain text link next to a title. Several labels get the full set of buttons. */
  single?: boolean;
};

/**
 * Buttons for one part of a delivery or batch: print straight to the label printer through the print helper
 * (scripts/print_bridge.py) running on this computer, preview the labels on screen, or open the PDF for the
 * browser's print dialog. The print button always shows: whether a printer is reachable is a property of the
 * computer the user is on, not of the server, so only the browser can find out (it says so when it fails). Each part is its own action, so a label
 * that is already printed is never printed again just because another one was needed.
 */
export function LabelButtons(props: Props) {
  const { label, single = false, only } = props;
  const target = "batch" in props ? `batch=${encodeURIComponent(props.batch)}` : `delivery=${encodeURIComponent(props.delivery)}`;
  const q = `${target}&only=${only}`;
  const printTarget = "batch" in props ? { batch: props.batch } : { delivery: props.delivery };

  if (single) {
    // Plain text links, not buttons: they sit next to the page title.
    return (
      <>
        <a
          href={`/api/labels?${q}&format=pdf`}
          target="_blank"
          rel="noreferrer"
          className="text-sm font-semibold text-side-title underline"
        >
          {label}
        </a>
        <a
          href={`/api/labels?${q}&format=preview`}
          target="_blank"
          rel="noreferrer"
          className="text-sm font-semibold text-side-title underline"
        >
          Preview
        </a>
        <PrintButton {...printTarget} only={only} label="Print label to printer" plain />
      </>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <PrintButton {...printTarget} only={only} label="Print labels to printer" />
      <a href={`/api/labels?${q}&format=pdf`} target="_blank" rel="noreferrer" className={primaryLinkButtonClass}>
        Open PDF (one label per page)
      </a>
      <a
        href={`/api/labels?${q}&format=preview`}
        target="_blank"
        rel="noreferrer"
        className="text-sm font-semibold text-side-title underline"
      >
        Preview
      </a>
    </div>
  );
}
