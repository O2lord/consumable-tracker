import Link from "next/link";
import { notFound } from "next/navigation";
import { can, canWorkAtAnyLocation } from "@/server/auth/permissions";
import { listActiveItemTypes, listActiveLocations } from "@/server/services/catalog.service";
import { getRequestDetail } from "@/server/services/request.service";
import { REQUEST_STATUS_LABEL } from "@/types/requests";
import { TRANSFER_STATUS_LABEL } from "@/types/transfers";
import { ActionForm } from "@/components/forms/ActionForm";
import { Field } from "@/components/ui/Field";
import { PackEquivalent } from "@/components/ui/PackEquivalent";
import { Tag } from "@/components/ui/Tag";
import { cardClass, ghostButtonClass, inputClass, tableClass, tdClass, thClass } from "@/components/ui/styles";
import {
  anotherTransferAction,
  approveRequestAction,
  cancelRequestAction,
  closeLineAction,
  submitRequestAction,
  updateDraftAction,
} from "../actions";
import { requireRequestsAccess, seesAllRequests, worksAt } from "../access";
import { RequestForm } from "../RequestForm";
import { LocationEditor } from "./LocationEditor";
import { RejectRequestDialog } from "./RejectRequestDialog";
import { STATUS_TONE } from "../status";

export const metadata = { title: "Stock request" };

type RequestLine = NonNullable<Awaited<ReturnType<typeof getRequestDetail>>>["lines"][number];

/**
 * A line quantity with its unit beside it ("10 Pack"), plus the piece equivalent for packs, so it is never a guess.
 * A line asked for in loose pieces shows "10 pieces" and no pack equivalent.
 */
function Qty({ value, line }: { value: number; line: RequestLine }) {
  if (line.inPieces) {
    return (
      <>
        {value.toLocaleString("en-GB")}
        <span className="ml-1 text-xs text-muted">{value === 1 ? "piece" : "pieces"}</span>
      </>
    );
  }
  return (
    <>
      {value}
      <span className="ml-1 text-xs text-muted">{line.unitOfMeasure}</span>
      <PackEquivalent quantity={value} unit={line.unitOfMeasure} packSize={line.packSize} confirmed={line.packSizeConfirmed} />
    </>
  );
}

export default async function RequestPage({ params }: { params: Promise<{ code: string }> }) {
  const session = await requireRequestsAccess();
  const { code } = await params;
  const detail = await getRequestDetail(decodeURIComponent(code));
  if (!detail) notFound();

  const { request: r, lines, transfers: linked } = detail;

  // Lab staff and store keepers only see requests that involve their own location.
  const involved =
    seesAllRequests(session) ||
    (session.homeLocationId !== null &&
      (session.homeLocationId === r.requestingLocationId || session.homeLocationId === r.storeLocationId));
  if (!involved) notFound();

  const labSide = can(session.role, "create_request") && worksAt(session, r.requestingLocationId);
  const storeSide = can(session.role, "review_requests") && worksAt(session, r.storeLocationId);
  const canDispatch = can(session.role, "dispatch");

  const status = r.status;
  const isDraft = status === "DRAFT";
  const isSubmitted = status === "SUBMITTED";
  const isActive = status === "APPROVED" || status === "PARTIALLY_FULFILLED";
  const reviewed = !isDraft && !isSubmitted;
  const hasOpenBalance = lines.some((l) => l.openBalance > 0);
  const hasDraftTransfer = linked.some((t) => t.status === "DRAFT");

  const items = isDraft && labSide ? (await listActiveItemTypes()).map((i) => ({ id: i.id, name: i.name, unit: i.unitOfMeasure, packSize: i.packSize, packSizeConfirmed: i.packSizeConfirmed })) : [];

  // A draft can be moved to another store from the pen beside the location line. Supervisors and admins can also
  // change which location is asking.
  const draftLocations = isDraft && labSide ? await listActiveLocations() : [];
  const stores = draftLocations.filter((l) => l.type === "STORE").map((l) => ({ id: l.id, name: l.name }));
  const requestingOptions = canWorkAtAnyLocation(session.role)
    ? draftLocations.filter((l) => l.type !== "STORE").map((l) => ({ id: l.id, name: l.name }))
    : undefined;

  const historySteps = [
    { label: "Created", who: detail.requestedByName, at: r.createdAt, wait: "" },
    { label: "Sent to the store", who: null, at: r.submittedAt, wait: "Not sent yet" },
    { label: "Reviewed", who: detail.reviewedByName, at: r.reviewedAt, wait: "Waiting for the store" },
  ];
  const latestStep = [...historySteps].reverse().find((s) => s.at) ?? historySteps[0];
  const shortDate = (d: Date) => d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  const shortTime = (d: Date) => d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

  return (
    <div className="flex flex-col gap-6">
      <div>
        <p className="text-sm">
          <Link href="/store/requests" className="underline">
            Stock requests
          </Link>
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-3">
          <h1 className="font-mono text-xl font-semibold">{r.code}</h1>
          <Tag tone={STATUS_TONE[status] ?? "brand"}>{REQUEST_STATUS_LABEL[status] ?? status}</Tag>
        </div>
        <div className="mt-1 text-sm text-zinc-500">
          {isDraft && labSide ? (
            <LocationEditor
              requestId={r.id}
              code={r.code}
              requestingName={detail.requestingName}
              storeName={detail.storeName}
              requestingLocationId={r.requestingLocationId}
              storeLocationId={r.storeLocationId}
              stores={stores}
              requestingOptions={requestingOptions}
            />
          ) : (
            <p>
              {detail.requestingName} asked {detail.storeName}.
            </p>
          )}
        </div>
        <details className="group mt-3 w-full rounded-lg border border-line bg-surface sm:w-96">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-3 py-2 text-sm font-medium [&::-webkit-details-marker]:hidden">
            <span>
              History
              <span className="font-normal text-muted">
                {" · "}
                {latestStep.label} {latestStep.at ? shortDate(latestStep.at) : ""}
              </span>
            </span>
            <svg
              viewBox="0 0 20 20"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              className="h-4 w-4 shrink-0 text-muted transition-transform group-open:rotate-180"
            >
              <path d="m5 8 5 5 5-5" />
            </svg>
          </summary>
          <ol aria-label="Request history" className="flex flex-col gap-4 border-t border-line px-3 py-3">
            {historySteps.map((s) => (
              <li key={s.label} className="flex gap-3">
                <span
                  aria-hidden="true"
                  className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${s.at ? "bg-brand" : "border-2 border-line"}`}
                />
                <div>
                  <p className="text-[13px] font-semibold text-muted">{s.label}</p>
                  {s.at ? (
                    <p className="text-sm">
                      {s.who ? <span className="font-medium">{s.who}</span> : null}
                      {s.who ? " · " : ""}
                      <span className="text-muted">
                        {shortDate(s.at)}, {shortTime(s.at)}
                      </span>
                    </p>
                  ) : (
                    <p className="text-sm text-muted">{s.wait}</p>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </details>
        {r.note ? <p className="mt-1 text-sm">Note from the lab: {r.note}</p> : null}
        {r.reviewNote ? <p className="mt-1 text-sm">Note from the store: {r.reviewNote}</p> : null}
      </div>

      {/* Lab side: a draft can be edited, sent or withdrawn. */}
      {isDraft && labSide ? (
        <section className={`${cardClass} flex flex-col gap-4`}>
          <RequestForm
            action={updateDraftAction}
            title="Edit draft"
            submitLabel="Save draft"
            items={items}
            requestId={r.id}
            code={r.code}
            initialNote={r.note ?? ""}
            initialLines={lines.map((l) => ({ itemTypeId: l.itemTypeId, quantity: l.quantityRequested, inPieces: l.inPieces }))}
          />
          <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-t border-line pt-4">
            <p className="max-w-md text-xs text-zinc-500">
              Save any changes first. The store&apos;s stock is checked when you send, and you will be told which items
              are short.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <ActionForm
                action={cancelRequestAction}
                submitLabel="Cancel request"
                resetOnSuccess={false}
                danger
                confirm="Cancel this request?"
                buttonClassName={`${ghostButtonClass} py-2.5 text-bad`}
                className="flex items-center"
              >
                <input type="hidden" name="requestId" value={r.id} />
                <input type="hidden" name="code" value={r.code} />
              </ActionForm>
              <ActionForm action={submitRequestAction} submitLabel="Send to the store" resetOnSuccess={false} className="flex items-center">
                <input type="hidden" name="requestId" value={r.id} />
                <input type="hidden" name="code" value={r.code} />
              </ActionForm>
            </div>
          </div>
        </section>
      ) : null}

      {isSubmitted && labSide ? (
        <section className={`${cardClass} flex flex-col gap-2`}>
          <p className="text-sm">Waiting for the store to approve or reject this request. You can withdraw it until then.</p>
          <ActionForm
            action={cancelRequestAction}
            submitLabel="Withdraw request"
            resetOnSuccess={false}
            danger
                confirm="Withdraw this request?"
          >
            <input type="hidden" name="requestId" value={r.id} />
            <input type="hidden" name="code" value={r.code} />
          </ActionForm>
        </section>
      ) : null}

      {/* Store side: review a submitted request. */}
      {isSubmitted && storeSide ? (
        <section className={`${cardClass} flex flex-col gap-4`}>
          <h2 className="font-medium">Review this request</h2>
          <ActionForm
            action={approveRequestAction}
            submitLabel="Approve and start transfer"
            resetOnSuccess={false}
            className="flex flex-col gap-3"
            extraActions={<RejectRequestDialog requestId={r.id} code={r.code} />}
          >
            <input type="hidden" name="requestId" value={r.id} />
            <input type="hidden" name="code" value={r.code} />
            <div className="overflow-x-auto">
              <table className={tableClass}>
                <thead>
                  <tr>
                    <th className={thClass}>Item</th>
                    <th className={thClass}>Requested</th>
                    <th className={thClass}>Approve</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l) => (
                    <tr key={l.id}>
                      <td className={tdClass}>{l.itemName}</td>
                      <td className={tdClass}>
                        <Qty value={l.quantityRequested} line={l} />
                      </td>
                      <td className={tdClass}>
                        <input type="hidden" name="lineId" value={l.id} />
                        <input
                          name="quantityApproved"
                          type="number"
                          inputMode="numeric"
                          min={0}
                          max={l.quantityRequested}
                          step={1}
                          defaultValue={l.quantityRequested}
                          className={`${inputClass} w-24`}
                          aria-label={`Quantity to approve for ${l.itemName}`}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-zinc-500">
              Enter 0 to decline an item, or a lower number to send less. Approving creates a draft transfer for you to
              fill.
            </p>
            <Field label="Note for the lab (optional)">
              <textarea name="reviewNote" rows={2} maxLength={500} className={inputClass} />
            </Field>
          </ActionForm>
        </section>
      ) : null}

      <section className="overflow-x-auto rounded-xl border border-line bg-surface px-2 py-1">
        <h2 className="mb-2 font-medium">Items</h2>
        <table className={tableClass}>
          <thead>
            <tr>
              <th className={thClass}>Item</th>
              <th className={thClass}>Requested</th>
              {reviewed ? <th className={thClass}>Approved</th> : null}
              {reviewed ? <th className={thClass}>Sent</th> : null}
              {reviewed ? <th className={thClass}>Received</th> : null}
              {reviewed ? <th className={thClass}>Still to send</th> : null}
              {isActive && storeSide ? <th className={thClass}>Close line</th> : null}
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.id}>
                <td className={tdClass}>{l.itemName}</td>
                <td className={tdClass}>
                  <Qty value={l.quantityRequested} line={l} />
                </td>
                {reviewed ? (
                  <td className={tdClass}>
                    {l.quantityApproved != null ? <Qty value={l.quantityApproved} line={l} /> : "-"}
                  </td>
                ) : null}
                {reviewed ? (
                  <td className={tdClass}>
                    <Qty value={l.quantityDispatched} line={l} />
                  </td>
                ) : null}
                {reviewed ? (
                  <td className={tdClass}>
                    <Qty value={l.quantityReceived} line={l} />
                  </td>
                ) : null}
                {reviewed ? (
                  <td className={tdClass}>
                    {l.closedAt ? (
                      <span title={l.closeReason ?? undefined}>
                        <Tag tone="bad">Closed</Tag>
                        {l.closeReason ? <span className="ml-2 text-xs text-zinc-500">{l.closeReason}</span> : null}
                      </span>
                    ) : l.quantityApproved === 0 ? (
                      "Declined"
                    ) : l.openBalance > 0 ? (
                      <Tag tone="warn">
                        {l.openBalance}
                        {l.inPieces ? (l.openBalance === 1 ? " piece" : " pieces") : ""}
                      </Tag>
                    ) : (
                      "-"
                    )}
                  </td>
                ) : null}
                {isActive && storeSide ? (
                  <td className={tdClass}>
                    {l.openBalance > 0 ? (
                      <ActionForm
                        action={closeLineAction}
                        submitLabel="Close"
                        compact
                        resetOnSuccess={false}
                        danger
                confirm={`Close ${l.itemName}? The ${l.openBalance}${l.inPieces ? " pieces" : ""} still to send will not be sent.`}
                        className="flex flex-wrap items-center gap-2"
                      >
                        <input type="hidden" name="requestId" value={r.id} />
                        <input type="hidden" name="code" value={r.code} />
                        <input type="hidden" name="lineId" value={l.id} />
                        <input
                          name="reason"
                          required
                          minLength={3}
                          maxLength={500}
                          placeholder="Reason"
                          className={`${inputClass} w-40 py-1 text-sm`}
                          aria-label={`Reason for closing ${l.itemName}`}
                        />
                      </ActionForm>
                    ) : (
                      "-"
                    )}
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {isActive && storeSide && hasOpenBalance && !hasDraftTransfer ? (
        <section className={`${cardClass} flex flex-col gap-2`}>
          <p className="text-sm">There is stock still to send and no draft transfer open for this request.</p>
          <ActionForm action={anotherTransferAction} submitLabel="Start another transfer" resetOnSuccess={false}>
            <input type="hidden" name="requestId" value={r.id} />
            <input type="hidden" name="code" value={r.code} />
          </ActionForm>
        </section>
      ) : null}

      {reviewed && linked.length > 0 ? (
        <section className="overflow-x-auto rounded-xl border border-line bg-surface px-2 py-1">
          <h2 className="mb-2 font-medium">Transfers for this request</h2>
          <table className={tableClass}>
            <thead>
              <tr>
                <th className={thClass}>Transfer</th>
                <th className={thClass}>Status</th>
                <th className={thClass}>Started</th>
                <th className={thClass}>Dispatched</th>
              </tr>
            </thead>
            <tbody>
              {linked.map((t) => (
                <tr key={t.id}>
                  <td className={`${tdClass} font-mono`}>
                    {canDispatch ? (
                      <Link href={`/store/transfers/${t.code}`} className="underline">
                        {t.code}
                      </Link>
                    ) : (
                      t.code
                    )}
                  </td>
                  <td className={tdClass}>{TRANSFER_STATUS_LABEL[t.status] ?? t.status}</td>
                  <td className={tdClass}>{t.createdAt.toLocaleString("en-GB")}</td>
                  <td className={tdClass}>{t.dispatchedAt ? t.dispatchedAt.toLocaleString("en-GB") : "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}
    </div>
  );
}
