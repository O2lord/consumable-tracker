import { primaryLinkButtonClass } from "@/components/ui/styles";

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
 * PDF button for one part of a delivery or batch. Labels are printed from the PDF through the browser's
 * print dialog. Each part is its own action, so a label that is already printed is never printed again just
 * because another one was needed.
 */
export function LabelButtons(props: Props) {
  const { label, single = false, only } = props;
  const target = "batch" in props ? `batch=${encodeURIComponent(props.batch)}` : `delivery=${encodeURIComponent(props.delivery)}`;
  const q = `${target}&only=${only}`;

  if (single) {
    // A plain text link, not a button: it sits next to the page title.
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

  return (
    <div className="flex flex-wrap items-center gap-3">
      <a href={`/api/labels?${q}&format=pdf`} target="_blank" rel="noreferrer" className={primaryLinkButtonClass}>
        Open PDF (one label per page)
      </a>
    </div>
  );
}
