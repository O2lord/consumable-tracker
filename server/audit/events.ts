import "server-only";
import { db } from "../db/client";
import { events } from "../db/schema";

/** A Drizzle handle: the pool itself, or a transaction (what services pass in). */
export type Db = ReturnType<typeof db>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type DbOrTx = Db | Tx;

export type NewEvent = typeof events.$inferInsert;

// Postgres allows 65,535 bind parameters per statement; events has ~17 columns.
const CHUNK = 500;

/**
 * The single place that appends to the ledger. Call it inside the same transaction as the
 * state change it records. Events are keyed by a client-generated UUID, so replaying one
 * is a no-op: the returned array lists the ids that were actually inserted.
 */
export async function appendEvents(conn: DbOrTx, rows: NewEvent[]): Promise<string[]> {
  const inserted: string[] = [];
  for (let i = 0; i < rows.length; i += CHUNK) {
    const result = await conn
      .insert(events)
      .values(rows.slice(i, i + CHUNK))
      .onConflictDoNothing({ target: events.id })
      .returning({ id: events.id });
    inserted.push(...result.map((r) => r.id));
  }
  return inserted;
}

export async function appendEvent(conn: DbOrTx, row: NewEvent): Promise<boolean> {
  const inserted = await appendEvents(conn, [row]);
  return inserted.length === 1;
}
