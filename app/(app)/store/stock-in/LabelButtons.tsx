import { linkButtonClass, primaryLinkButtonClass } from "@/components/ui/styles";
import { PrintButton } from "./[batchCode]/PrintButton";

type Props = (
  | { batch: string; only: "batch" | "items" }
  | { delivery: string; only: "delivery" | "batches" }
) & {
  /** For a single label this is the link text. Several labels get the full PDF button. */
  label: string;
  /** One label, shown as a plain text link next to a title. Several labels get the full set of buttons. */
  single?: boolean;
  /** Stack the actions in a narrow column (a print button over PDF and Preview), for a side panel. */
  stacked?: boolean;
};

/**
 * Buttons for one part of a delivery or batch: print straight to the label printer through the print helper
 * (scripts/print_bridge.py) running on this computer, preview the labels on screen, or open the PDF for the
 * browser's print dialog. The print button always shows: whether a printer is reachable is a property of the
 * computer the user is on, not of the server, so only the browser can find out (it says so when it fails). Each part is its own action, so a label
 * that is already printed is never printed again just because another one was needed.
 */
export function LabelButtons(props: Props) {
  const { label, single = false, stacked = false, only } = props;
  const target = "batch" in props ? `batch=${encodeURIComponent(props.batch)}` : `delivery=${encodeURIComponent(props.delivery)}`;
  const q = `${target}&only=${only}`;
  const printTarget = "batch" in props ? { batch: props.batch } : { delivery: props.delivery };

  if (single) {
    // A single plain text link, not a button: it sits next to the page title.
    return <PrintButton {...printTarget} only={only} label={label} plain />;
  }

  if (stacked) {
    return (
      <div className="flex w-full flex-col gap-2">
        <div className="grid grid-cols-2 gap-2">
          <a
            href={`/api/labels?${q}&format=pdf`}
            target="_blank"
            rel="noreferrer"
            className={`${linkButtonClass} justify-center`}
          >
            Open PDF
          </a>
          <a
            href={`/api/labels?${q}&format=preview`}
            target="_blank"
            rel="noreferrer"
            className={`${linkButtonClass} justify-center`}
          >
            Preview
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
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
