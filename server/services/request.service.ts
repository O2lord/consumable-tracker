import "server-only";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { DbOrTx, Tx } from "../audit/events";
import { canWorkAtAnyLocation } from "../auth/permissions";
import { db } from "../db/client";
import { isUniqueViolation } from "../db/errors";
import { itemTypes, locations, stockRequestLines, stockRequests, transfers, users } from "../db/schema";
import { NotFoundError, PermissionDeniedError, ValidationError } from "../domain/errors";
import {
  assertApprovalValid,
  assertAvailableForRequest,
  assertCanCloseLine,
  assertRequestStatus,
  openBalance,
} from "../domain/request-rules";
import type { Actor } from "../domain/types";
import { generateRequestCode, parseRequestCode } from "../../lib/serial";
import { pageInfo, type Paged } from "../../lib/pagination";
import {
  approveRequestSchema,
  closeRequestLineSchema,
  createRequestSchema,
  rejectRequestSchema,
  updateDraftRequestSchema,
  updateDraftLocationsSchema,
  type ApproveRequestInput,
  type CloseRequestLineInput,
  type CreateRequestInput,
  type RejectRequestInput,
  type UpdateDraftRequestInput,
  type UpdateDraftLocationsInput,
} from "../../types/requests";
import { lockRequest, syncRequestFromTransfers } from "./request-sync.service";
import { getAvailableByItemType, getAvailablePiecesByItemType } from "./stock.service";
import { createTransfer } from "./transfer.service";

// Stock requests (architecture: a lab asks the store, the store approves, a linked transfer moves the
// stock). A request never moves stock itself: approval only creates a draft transfer, and the quantities
// on the lines follow that transfer as it is dispatched and received (request-sync.service).
//
// Callers check the permission first: create_request for the lab side (create, edit, submit, cancel),
// review_requests for the store side (approve, reject, close a line, start another transfer). The
// location checks below are the second half: a lab works on its own location's requests, a store
// keeper on their own store's. Supervisors and admins may act at any location.

function assertWorksAt(actor: Pick<Actor, "role" | "homeLocationId">, locationId: string, message: string): void {
  if (canWorkAtAnyLocation(actor.role)) return;
  if (actor.homeLocationId !== locationId) throw new PermissionDeniedError(message);
}

/** The item types must exist and be active, or the lab would be asking for something no one can send. */
async function assertRequestableItems(conn: DbOrTx, itemTypeIds: readonly string[]): Promise<void> {
  const found = await conn
    .select({ id: itemTypes.id })
    .from(itemTypes)
    .where(and(inArray(itemTypes.id, [...itemTypeIds]), eq(itemTypes.active, true)));
  if (found.length !== new Set(itemTypeIds).size) {
    throw new ValidationError("One of the items can no longer be requested. Remove it and try again");
  }
}

function parseOrThrow<T>(result: { success: true; data: T } | { success: false; error: { issues: { message: string }[] } }): T {
  if (!result.success) throw new ValidationError(result.error.issues.map((i) => i.message).join("; "));
  return result.data;
}

// --- lab side: create, edit, submit, cancel ------------------------------------------

export async function createRequest(rawInput: CreateRequestInput, actor: Actor, conn: DbOrTx = db()) {
  const input = parseOrThrow(createRequestSchema.safeParse(rawInput));
  assertWorksAt(actor, input.requestingLocationId, "You can only make requests for your own location");

  return conn.transaction(async (tx) => {
    const [from] = await tx.select().from(locations).where(eq(locations.id, input.requestingLocationId));
    if (!from || !from.active) throw new NotFoundError("Your location");
    const [store] = await tx.select().from(locations).where(eq(locations.id, input.storeLocationId));
    if (!store || !store.active) throw new NotFoundError("Store");
    if (store.type !== "STORE") throw new ValidationError("Requests can only be sent to a store location");

    await assertRequestableItems(tx, input.lines.map((l) => l.itemTypeId));

    let request: typeof stockRequests.$inferSelect;
    try {
      [request] = await tx
        .insert(stockRequests)
        .values({
          code: generateRequestCode(),
          requestingLocationId: from.id,
          storeLocationId: store.id,
          status: "DRAFT",
          note: input.note ?? null,
          requestedBy: actor.userId,
        })
        .returning();
    } catch (err) {
      if (isUniqueViolation(err)) throw new ValidationError("Could not create the request. Try again");
      throw err;
    }

    await tx.insert(stockRequestLines).values(
      input.lines.map((l) => ({
        requestId: request.id,
        itemTypeId: l.itemTypeId,
        quantityRequested: l.quantity,
        inPieces: l.inPieces,
      })),
    );
    return request;
  });
}

/** Replaces a draft's note and lines. The locations are changed separately, by updateDraftLocations. */
export async function updateDraftRequest(
  requestId: string,
  rawInput: UpdateDraftRequestInput,
  actor: Actor,
  conn: DbOrTx = db(),
) {
  const input = parseOrThrow(updateDraftRequestSchema.safeParse(rawInput));

  return conn.transaction(async (tx) => {
    const request = await lockRequest(tx, requestId);
    assertWorksAt(actor, request.requestingLocationId, "This request belongs to a different location than yours");
    assertRequestStatus(request.status, ["DRAFT"], "edit");
    await assertRequestableItems(tx, input.lines.map((l) => l.itemTypeId));

    await tx.delete(stockRequestLines).where(eq(stockRequestLines.requestId, request.id));
    await tx.insert(stockRequestLines).values(
      input.lines.map((l) => ({
        requestId: request.id,
        itemTypeId: l.itemTypeId,
        quantityRequested: l.quantity,
        inPieces: l.inPieces,
      })),
    );
    const [row] = await tx
      .update(stockRequests)
      .set({ note: input.note === undefined ? request.note : input.note })
      .where(eq(stockRequests.id, request.id))
      .returning();
    return row;
  });
}

/**
 * Changes which location is asking and which store is asked, while the request is still a draft (for example
 * when the first store is out of stock). Leave one out to keep it. Fixed once the request is sent.
 */
export async function updateDraftLocations(
  requestId: string,
  rawInput: UpdateDraftLocationsInput,
  actor: Actor,
  conn: DbOrTx = db(),
) {
  const input = parseOrThrow(updateDraftLocationsSchema.safeParse(rawInput));

  return conn.transaction(async (tx) => {
    const request = await lockRequest(tx, requestId);
    assertWorksAt(actor, request.requestingLocationId, "This request belongs to a different location than yours");
    assertRequestStatus(request.status, ["DRAFT"], "edit");

    const requestingLocationId = input.requestingLocationId ?? request.requestingLocationId;
    const storeLocationId = input.storeLocationId ?? request.storeLocationId;
    if (requestingLocationId === storeLocationId) throw new ValidationError("Ask a different location than your own");

    if (requestingLocationId !== request.requestingLocationId) {
      // Moving the draft to another location: the person must be allowed to work there too.
      assertWorksAt(actor, requestingLocationId, "You can only make requests for your own location");
      const [from] = await tx.select().from(locations).where(eq(locations.id, requestingLocationId));
      if (!from || !from.active) throw new NotFoundError("Requesting location");
    }
    if (storeLocationId !== request.storeLocationId) {
      const [store] = await tx.select().from(locations).where(eq(locations.id, storeLocationId));
      if (!store || !store.active) throw new NotFoundError("Store");
      if (store.type !== "STORE") throw new ValidationError("Requests can only be sent to a store location");
    }

    const [row] = await tx
      .update(stockRequests)
      .set({ requestingLocationId, storeLocationId })
      .where(eq(stockRequests.id, request.id))
      .returning();
    return row;
  });
}

/**
 * Sends a draft to the store. The stock check runs here, on the server, whatever the form showed: the
 * store must be able to send every line right now (expired stock and stock already on open drafts do
 * not count). All short items are reported together so the lab fixes them in one go.
 */
export async function submitRequest(requestId: string, actor: Actor, conn: DbOrTx = db()) {
  return conn.transaction(async (tx) => {
    const request = await lockRequest(tx, requestId);
    assertWorksAt(actor, request.requestingLocationId, "This request belongs to a different location than yours");
    assertRequestStatus(request.status, ["DRAFT"], "submit");

    const lines = await tx
      .select({
        itemTypeId: stockRequestLines.itemTypeId,
        quantityRequested: stockRequestLines.quantityRequested,
        inPieces: stockRequestLines.inPieces,
        itemName: itemTypes.name,
      })
      .from(stockRequestLines)
      .innerJoin(itemTypes, eq(itemTypes.id, stockRequestLines.itemTypeId))
      .where(eq(stockRequestLines.requestId, request.id))
      .orderBy(asc(itemTypes.name));
    if (lines.length === 0) throw new ValidationError("Add at least one item before submitting");

    const available = await getAvailableByItemType(request.storeLocationId, lines.map((l) => l.itemTypeId), tx);
    // Lines asked for in pieces are checked in pieces: sealed packs times pack size, plus loose pieces.
    const pieceIds = lines.filter((l) => l.inPieces).map((l) => l.itemTypeId);
    const availablePieces = await getAvailablePiecesByItemType(request.storeLocationId, pieceIds, tx);
    const problems: string[] = [];
    for (const l of lines) {
      try {
        assertAvailableForRequest({
          itemName: l.itemName,
          requested: l.quantityRequested,
          available: (l.inPieces ? availablePieces : available).get(l.itemTypeId) ?? 0,
          unitWord: l.inPieces ? "pieces" : undefined,
        });
      } catch (err) {
        if (err instanceof ValidationError) problems.push(err.message);
        else throw err;
      }
    }
    if (problems.length > 0) throw new ValidationError(problems.join("; "));

    const [row] = await tx
      .update(stockRequests)
      .set({ status: "SUBMITTED", submittedAt: new Date() })
      .where(eq(stockRequests.id, request.id))
      .returning();
    return row;
  });
}

/** The lab withdraws a request the store has not acted on yet. */
export async function cancelRequest(requestId: string, actor: Actor, conn: DbOrTx = db()) {
  return conn.transaction(async (tx) => {
    const request = await lockRequest(tx, requestId);
    assertWorksAt(actor, request.requestingLocationId, "This request belongs to a different location than yours");
    assertRequestStatus(request.status, ["DRAFT", "SUBMITTED"], "cancel");
    const [row] = await tx
      .update(stockRequests)
      .set({ status: "CANCELLED" })
      .where(eq(stockRequests.id, request.id))
      .returning();
    return row;
  });
}

// --- store side: approve, reject, close a line, more transfers --------------------------

/**
 * Approves a submitted request, line by line (0 declines a line, a number below the request lowers it),
 * and creates the linked draft transfer for the store keeper to fill. Both happen in one transaction.
 * Stock is not reserved: the dispatch checks do the real work when the transfer is confirmed.
 */
export async function approveRequest(requestId: string, rawInput: ApproveRequestInput, actor: Actor, conn: DbOrTx = db()) {
  const input = parseOrThrow(approveRequestSchema.safeParse(rawInput));

  return conn.transaction(async (tx) => {
    const request = await lockRequest(tx, requestId);
    assertWorksAt(actor, request.storeLocationId, "This request was sent to a different store than yours");
    assertRequestStatus(request.status, ["SUBMITTED"], "approve");

    const lines = await tx
      .select()
      .from(stockRequestLines)
      .where(eq(stockRequestLines.requestId, request.id))
      .for("update");
    const names = await itemNames(tx, lines.map((l) => l.itemTypeId));

    const lineIds = new Set(lines.map((l) => l.id));
    if (input.lines.some((l) => !lineIds.has(l.lineId))) {
      throw new ValidationError("One of the lines is not on this request. Reload the page and try again");
    }
    const decided = new Map(input.lines.map((l) => [l.lineId, l.quantityApproved]));
    if (lines.some((l) => !decided.has(l.id))) {
      throw new ValidationError("Set a quantity for every item (0 declines an item)");
    }

    assertApprovalValid(
      lines.map((l) => ({
        lineId: l.id,
        itemName: names.get(l.itemTypeId) ?? "Item",
        quantityRequested: l.quantityRequested,
        quantityApproved: decided.get(l.id) as number,
      })),
    );

    for (const l of lines) {
      await tx
        .update(stockRequestLines)
        .set({ quantityApproved: decided.get(l.id) as number })
        .where(eq(stockRequestLines.id, l.id));
    }

    const [approved] = await tx
      .update(stockRequests)
      .set({
        status: "APPROVED",
        reviewedBy: actor.userId,
        reviewedAt: new Date(),
        reviewNote: input.reviewNote ?? null,
      })
      .where(eq(stockRequests.id, request.id))
      .returning();

    const transfer = await startTransferFor(tx, approved, actor.userId);
    return { request: approved, transfer };
  });
}

export async function rejectRequest(requestId: string, rawInput: RejectRequestInput, actor: Actor, conn: DbOrTx = db()) {
  const input = parseOrThrow(rejectRequestSchema.safeParse(rawInput));

  return conn.transaction(async (tx) => {
    const request = await lockRequest(tx, requestId);
    assertWorksAt(actor, request.storeLocationId, "This request was sent to a different store than yours");
    assertRequestStatus(request.status, ["SUBMITTED"], "reject");
    const [row] = await tx
      .update(stockRequests)
      .set({ status: "REJECTED", reviewedBy: actor.userId, reviewedAt: new Date(), reviewNote: input.reviewNote })
      .where(eq(stockRequests.id, request.id))
      .returning();
    return row;
  });
}

/**
 * The store gives up the open balance of one line, with a reason. What was already sent stays sent.
 * Closing the last open line moves the request to Closed (or Fulfilled once nothing is on its way).
 */
export async function closeRequestLine(
  requestId: string,
  lineId: string,
  rawInput: CloseRequestLineInput,
  actor: Actor,
  conn: DbOrTx = db(),
) {
  const input = parseOrThrow(closeRequestLineSchema.safeParse(rawInput));

  return conn.transaction(async (tx) => {
    const request = await lockRequest(tx, requestId);
    assertWorksAt(actor, request.storeLocationId, "This request was sent to a different store than yours");
    assertRequestStatus(request.status, ["APPROVED", "PARTIALLY_FULFILLED"], "close a line on");

    const [line] = await tx
      .select()
      .from(stockRequestLines)
      .where(and(eq(stockRequestLines.id, lineId), eq(stockRequestLines.requestId, request.id)))
      .for("update");
    if (!line) throw new NotFoundError("Line on this request");

    const reason = assertCanCloseLine(line, input.reason);
    const [closed] = await tx
      .update(stockRequestLines)
      .set({ closedAt: new Date(), closedBy: actor.userId, closeReason: reason })
      .where(eq(stockRequestLines.id, line.id))
      .returning();

    const status = await syncRequestFromTransfers(tx, request.id);
    return { line: closed, requestStatus: status };
  });
}

/**
 * Starts another draft transfer for what is still open on an approved request, for example after the
 * first draft was cancelled or after a partial dispatch. One draft at a time, so two store keepers do
 * not both fill the same balance.
 */
export async function createTransferForRequest(requestId: string, actor: Actor, conn: DbOrTx = db()) {
  return conn.transaction(async (tx) => {
    const request = await lockRequest(tx, requestId);
    assertWorksAt(actor, request.storeLocationId, "This request was sent to a different store than yours");
    assertRequestStatus(request.status, ["APPROVED", "PARTIALLY_FULFILLED"], "create a transfer for");
    return startTransferFor(tx, request, actor.userId);
  });
}

/** Shared by approval and "another transfer": needs the request row already locked by the caller. */
async function startTransferFor(tx: Tx, request: typeof stockRequests.$inferSelect, userId: string) {
  const lines = await tx.select().from(stockRequestLines).where(eq(stockRequestLines.requestId, request.id));
  if (!lines.some((l) => openBalance(l) > 0)) {
    throw new ValidationError("Nothing is left to send on this request");
  }

  const [existing] = await tx
    .select({ code: transfers.code })
    .from(transfers)
    .where(and(eq(transfers.requestId, request.id), eq(transfers.status, "DRAFT")));
  if (existing) {
    throw new ValidationError(`This request already has a draft transfer (${existing.code}). Finish or cancel it first`);
  }

  const transfer = await createTransfer(
    {
      fromLocationId: request.storeLocationId,
      toLocationId: request.requestingLocationId,
      note: `For request ${request.code}`,
    },
    userId,
    tx,
  );
  const [linked] = await tx
    .update(transfers)
    .set({ requestId: request.id })
    .where(eq(transfers.id, transfer.id))
    .returning();
  return linked;
}

// --- reads -------------------------------------------------------------------------------

async function itemNames(conn: DbOrTx, ids: readonly string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await conn.select({ id: itemTypes.id, name: itemTypes.name }).from(itemTypes).where(inArray(itemTypes.id, unique));
  return new Map(rows.map((r) => [r.id, r.name]));
}

async function locationNames(conn: DbOrTx, ids: readonly string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await conn.select({ id: locations.id, name: locations.name }).from(locations).where(inArray(locations.id, unique));
  return new Map(rows.map((r) => [r.id, r.name]));
}

async function userNames(conn: DbOrTx, ids: readonly (string | null)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (unique.length === 0) return new Map();
  const rows = await conn.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, unique));
  return new Map(rows.map((r) => [r.id, r.name]));
}

export interface RequestListRow {
  id: string;
  code: string;
  status: (typeof stockRequests.$inferSelect)["status"];
  requestingName: string;
  storeName: string;
  createdAt: Date;
  submittedAt: Date | null;
  lineCount: number;
  // Totals of the lines counted in the item's own unit. Lines counted in loose pieces are totalled apart below,
  // because pieces and whole units cannot be added together.
  requestedTotal: number;
  approvedTotal: number;
  dispatchedTotal: number;
  receivedTotal: number;
  requestedPieces: number;
  approvedPieces: number;
  dispatchedPieces: number;
  receivedPieces: number;
}

export async function listRequests(
  options: {
    requestingLocationId?: string;
    storeLocationId?: string;
    statuses?: readonly (typeof stockRequests.$inferSelect)["status"][];
    limit?: number;
    offset?: number;
  } = {},
  conn: DbOrTx = db(),
): Promise<RequestListRow[]> {
  const conditions = [];
  if (options.requestingLocationId) conditions.push(eq(stockRequests.requestingLocationId, options.requestingLocationId));
  if (options.storeLocationId) conditions.push(eq(stockRequests.storeLocationId, options.storeLocationId));
  if (options.statuses?.length) conditions.push(inArray(stockRequests.status, [...options.statuses]));

  const rows = await conn
    .select()
    .from(stockRequests)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(stockRequests.createdAt), desc(stockRequests.id))
    .limit(options.limit ?? 50)
    .offset(options.offset ?? 0);
  if (rows.length === 0) return [];

  const names = await locationNames(conn, rows.flatMap((r) => [r.requestingLocationId, r.storeLocationId]));
  const totals = await conn
    .select({
      requestId: stockRequestLines.requestId,
      lineCount: sql<number>`count(*)::int`,
      requested: sql<number>`coalesce(sum(${stockRequestLines.quantityRequested}) filter (where not ${stockRequestLines.inPieces}), 0)::int`,
      approved: sql<number>`coalesce(sum(${stockRequestLines.quantityApproved}) filter (where not ${stockRequestLines.inPieces}), 0)::int`,
      dispatched: sql<number>`coalesce(sum(${stockRequestLines.quantityDispatched}) filter (where not ${stockRequestLines.inPieces}), 0)::int`,
      received: sql<number>`coalesce(sum(${stockRequestLines.quantityReceived}) filter (where not ${stockRequestLines.inPieces}), 0)::int`,
      requestedPieces: sql<number>`coalesce(sum(${stockRequestLines.quantityRequested}) filter (where ${stockRequestLines.inPieces}), 0)::int`,
      approvedPieces: sql<number>`coalesce(sum(${stockRequestLines.quantityApproved}) filter (where ${stockRequestLines.inPieces}), 0)::int`,
      dispatchedPieces: sql<number>`coalesce(sum(${stockRequestLines.quantityDispatched}) filter (where ${stockRequestLines.inPieces}), 0)::int`,
      receivedPieces: sql<number>`coalesce(sum(${stockRequestLines.quantityReceived}) filter (where ${stockRequestLines.inPieces}), 0)::int`,
    })
    .from(stockRequestLines)
    .where(inArray(stockRequestLines.requestId, rows.map((r) => r.id)))
    .groupBy(stockRequestLines.requestId);
  const totalById = new Map(totals.map((t) => [t.requestId, t]));

  return rows.map((r) => {
    const t = totalById.get(r.id);
    return {
      id: r.id,
      code: r.code,
      status: r.status,
      requestingName: names.get(r.requestingLocationId) ?? "?",
      storeName: names.get(r.storeLocationId) ?? "?",
      createdAt: r.createdAt,
      submittedAt: r.submittedAt,
      lineCount: t?.lineCount ?? 0,
      requestedTotal: t?.requested ?? 0,
      approvedTotal: t?.approved ?? 0,
      dispatchedTotal: t?.dispatched ?? 0,
      receivedTotal: t?.received ?? 0,
      requestedPieces: t?.requestedPieces ?? 0,
      approvedPieces: t?.approvedPieces ?? 0,
      dispatchedPieces: t?.dispatchedPieces ?? 0,
      receivedPieces: t?.receivedPieces ?? 0,
    };
  });
}

/** One page (20 rows) of requests, newest first, plus the total that match. */
export async function listRequestsPage(
  options: {
    requestingLocationId?: string;
    storeLocationId?: string;
    statuses?: readonly (typeof stockRequests.$inferSelect)["status"][];
  },
  page: number,
  conn: DbOrTx = db(),
): Promise<Paged<RequestListRow>> {
  const conditions = [];
  if (options.requestingLocationId) conditions.push(eq(stockRequests.requestingLocationId, options.requestingLocationId));
  if (options.storeLocationId) conditions.push(eq(stockRequests.storeLocationId, options.storeLocationId));
  if (options.statuses?.length) conditions.push(inArray(stockRequests.status, [...options.statuses]));
  const [{ total }] = await conn
    .select({ total: sql<number>`count(*)::int` })
    .from(stockRequests)
    .where(conditions.length ? and(...conditions) : undefined);
  const info = pageInfo(page, total);
  const rows = await listRequests({ ...options, limit: info.pageSize, offset: info.offset }, conn);
  return { ...info, rows };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Everything a request page needs. `ref` is a request code or its id. */
export async function getRequestDetail(ref: string, conn: DbOrTx = db()) {
  const code = parseRequestCode(ref);
  const where = code ? eq(stockRequests.code, code) : UUID.test(ref) ? eq(stockRequests.id, ref) : null;
  if (!where) return null;
  const [request] = await conn.select().from(stockRequests).where(where);
  if (!request) return null;

  const [locs, people, lineRows, linkedTransfers] = await Promise.all([
    locationNames(conn, [request.requestingLocationId, request.storeLocationId]),
    userNames(conn, [request.requestedBy, request.reviewedBy]),
    conn
      .select({
        id: stockRequestLines.id,
        itemTypeId: stockRequestLines.itemTypeId,
        itemCode: itemTypes.code,
        itemName: itemTypes.name,
        unitOfMeasure: itemTypes.unitOfMeasure,
        // For showing piece equivalents beside pack quantities. Display only.
        packSize: itemTypes.packSize,
        packSizeConfirmed: itemTypes.packSizeConfirmed,
        // True when the four quantities below are loose pieces rather than the item's own unit.
        inPieces: stockRequestLines.inPieces,
        quantityRequested: stockRequestLines.quantityRequested,
        quantityApproved: stockRequestLines.quantityApproved,
        quantityDispatched: stockRequestLines.quantityDispatched,
        quantityReceived: stockRequestLines.quantityReceived,
        closedAt: stockRequestLines.closedAt,
        closeReason: stockRequestLines.closeReason,
      })
      .from(stockRequestLines)
      .innerJoin(itemTypes, eq(itemTypes.id, stockRequestLines.itemTypeId))
      .where(eq(stockRequestLines.requestId, request.id))
      .orderBy(asc(itemTypes.name)),
    conn
      .select({
        id: transfers.id,
        code: transfers.code,
        status: transfers.status,
        dispatchedAt: transfers.dispatchedAt,
        createdAt: transfers.createdAt,
      })
      .from(transfers)
      .where(eq(transfers.requestId, request.id))
      .orderBy(asc(transfers.createdAt)),
  ]);

  return {
    request,
    requestingName: locs.get(request.requestingLocationId) ?? "?",
    storeName: locs.get(request.storeLocationId) ?? "?",
    requestedByName: people.get(request.requestedBy) ?? "?",
    reviewedByName: request.reviewedBy ? (people.get(request.reviewedBy) ?? "?") : null,
    lines: lineRows.map((l) => ({ ...l, openBalance: openBalance(l) })),
    transfers: linkedTransfers,
  };
}

export type RequestDetail = NonNullable<Awaited<ReturnType<typeof getRequestDetail>>>;
