import Link from "next/link";
import { can, canWorkAtAnyLocation } from "@/server/auth/permissions";
import { listActiveItemTypes, listActiveLocations } from "@/server/services/catalog.service";
import { listRequestsPage } from "@/server/services/request.service";
import { REQUEST_STATUS_LABEL } from "@/types/requests";
import { Tag } from "@/components/ui/Tag";
import { tableClass, tdClass, thClass } from "@/components/ui/styles";
import { FormDialog } from "@/components/forms/FormDialog";
import { Pagination } from "@/components/ui/Pagination";
import { pageOfArray, parsePage } from "@/lib/pagination";
import { requireRequestsAccess, seesAllRequests } from "./access";
import { createRequestAction } from "./actions";
import { RequestForm } from "./RequestForm";
import { STATUS_TONE } from "./status";

export const metadata = { title: "Stock requests" };

/** Whole units and loose pieces cannot be added together, so a total shows them side by side: "2 + 10 pieces". */
function withPieces(units: number, pieces: number): string {
  if (pieces === 0) return String(units);
  const label = `${pieces.toLocaleString("en-GB")} ${pieces === 1 ? "piece" : "pieces"}`;
  return units > 0 ? `${units} + ${label}` : label;
}

export default async function RequestsPage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const session = await requireRequestsAccess();
  const sp = await searchParams;
  const canCreate = can(session.role, "create_request");
  const canReview = can(session.role, "review_requests");

  // Lab staff see their location's requests, store keepers the ones sent to their store.
  // Supervisors, admins and auditors see all of them.
  const noLocation = !seesAllRequests(session) && !session.homeLocationId;
  const requestPage = noLocation
    ? pageOfArray([], 1)
    : await listRequestsPage(
        seesAllRequests(session)
          ? {}
          : canReview
            ? { storeLocationId: session.homeLocationId as string }
            : { requestingLocationId: session.homeLocationId as string },
        parsePage(sp.page),
      );
  const requests = requestPage.rows;

  // The new-request form opens in a dialog, so its options are loaded here. Lab staff without a
  // location can't create a request, which the notice below already explains.
  const privileged = canWorkAtAnyLocation(session.role);
  const showCreate = canCreate && (privileged || Boolean(session.homeLocationId));
  const locations = showCreate ? await listActiveLocations() : [];
  const itemTypes = showCreate ? await listActiveItemTypes() : [];
  const stores = locations.filter((l) => l.type === "STORE").map((l) => ({ id: l.id, name: l.name }));
  const requestingOptions = privileged
    ? locations.filter((l) => l.type !== "STORE").map((l) => ({ id: l.id, name: l.name }))
    : undefined;
  const items = itemTypes.map((i) => ({ id: i.id, name: i.name, unit: i.unitOfMeasure, packSize: i.packSize, packSizeConfirmed: i.packSizeConfirmed }));

  const header = (
    <>
      <h1 className="text-xl font-semibold">Stock requests</h1>
      <p className="mt-1 text-sm text-zinc-500">
        {canReview && !canCreate
          ? "Requests sent to your store, most recent first."
          : "A location asks the store for stock. The store approves, then sends it on a transfer."}
      </p>
    </>
  );

  return (
    <div className="flex flex-col gap-4">
      {showCreate ? (
        <FormDialog
          buttonLabel="New request"
          title="New stock request"
          intro="Choose the store and what you need. You can check and edit it before sending."
          disabled={stores.length === 0}
          header={header}
        >
          <RequestForm
            action={createRequestAction}
            submitLabel="Save draft"
            items={items}
            stores={stores}
            requestingOptions={requestingOptions}
          />
        </FormDialog>
      ) : (
        <div>{header}</div>
      )}
      {showCreate && stores.length === 0 ? (
        <p className="text-sm text-zinc-500">There is no active store to ask. Ask an admin to add one.</p>
      ) : null}

      {noLocation ? (
        <p className="text-sm text-zinc-500">Your account has no location yet. Ask an admin to set one.</p>
      ) : null}

      <div className="overflow-x-auto rounded-xl border border-line bg-surface px-2 py-1">
        <table className={tableClass}>
          <thead>
            <tr>
              <th className={thClass}>Request</th>
              <th className={thClass}>Status</th>
              <th className={thClass}>From</th>
              <th className={thClass}>Store</th>
              <th className={thClass}>Items</th>
              <th className={thClass}>Approved</th>
              <th className={thClass}>Sent</th>
              <th className={thClass}>Received</th>
              <th className={thClass}>Created</th>
            </tr>
          </thead>
          <tbody>
            {requests.map((r) => (
              <tr key={r.id}>
                <td className={`${tdClass} font-mono`}>
                  <Link href={`/store/requests/${r.code}`} className="underline">
                    {r.code}
                  </Link>
                </td>
                <td className={tdClass}>
                  <Tag tone={STATUS_TONE[r.status] ?? "brand"}>{REQUEST_STATUS_LABEL[r.status] ?? r.status}</Tag>
                </td>
                <td className={tdClass}>{r.requestingName}</td>
                <td className={tdClass}>{r.storeName}</td>
                <td className={tdClass}>{withPieces(r.requestedTotal, r.requestedPieces)}</td>
                <td className={tdClass}>{r.status === "DRAFT" || r.status === "SUBMITTED" ? "-" : withPieces(r.approvedTotal, r.approvedPieces)}</td>
                <td className={tdClass}>{withPieces(r.dispatchedTotal, r.dispatchedPieces)}</td>
                <td className={tdClass}>{withPieces(r.receivedTotal, r.receivedPieces)}</td>
                <td className={tdClass}>{r.createdAt.toLocaleString("en-GB")}</td>
              </tr>
            ))}
            {requests.length === 0 ? (
              <tr>
                <td className={tdClass} colSpan={9}>
                  No requests yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
        <Pagination info={requestPage} pathname="/store/requests" noun="requests" />
      </div>
    </div>
  );
}
