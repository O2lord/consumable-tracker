import { linkButtonClass, primaryLinkButtonClass } from "@/components/ui/styles";

type Props = (
  | { batch: string; only: "batch" | "items" }
  | { delivery: string; only: "delivery" | "batches" }
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
 * print window, see docs/label-printing-setup.md) or preview the labels on screen. Nothing is installed on the PC
 * besides the printer's driver. Each part is its own action.
 */
export function LabelButtons(props: Props) {
  const { label, single = false, stacked = false, only } = props;
  const target = "batch" in props ? `batch=${encodeURIComponent(props.batch)}` : `delivery=${encodeURIComponent(props.delivery)}`;
  const q = `${target}&only=${only}`;

  if (single) {
    // A single plain text link, not a button: it sits next to the page title.
    return (
      <a
        href={`/api/labels?${q}&format=pdf`}
        target="_blank"
        rel="noreferrer"
        className="text-sm font-semibold text-side-title underline"
      >
        {label}
      </a>
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
