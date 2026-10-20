import "server-only";
import { eq } from "drizzle-orm";
import { voidReasons } from "../schema";
import { ValidationError } from "../../domain/errors";
import type { DbOrTx } from "../../audit/events";

/** A void reason must be on the controlled list and active. Returns its code. */
export async function requireVoidReason(conn: DbOrTx, code: string | undefined | null): Promise<string> {
  if (!code) throw new ValidationError("Choose a reason");
  const [row] = await conn.select().from(voidReasons).where(eq(voidReasons.code, code.trim().toUpperCase()));
  if (!row || !row.active) throw new ValidationError(`"${code}" is not an active reason. Choose one from the list`);
  return row.code;
}
