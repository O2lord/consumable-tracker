import "server-only";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "../env";
import * as schema from "./schema";

// One pool per process, reused across hot reloads in dev.
// Created lazily so `next build` does not need DATABASE_URL.
const globalForDb = globalThis as unknown as {
  __pg?: ReturnType<typeof postgres>;
};

export function sql() {
  return (globalForDb.__pg ??= postgres(env().DATABASE_URL, {
    // Required for Supabase's transaction pooler (port 6543); harmless on direct connections.
    prepare: false,
    max: 10,
    // Fail in 10s instead of hanging when the database is unreachable.
    connect_timeout: 10,
    // Keep idle sockets alive so a dead connection is noticed sooner.
    keep_alive: 30,
    // Close connections idle for 20s, so a socket the pooler or network has silently dropped
    // (laptop sleep, Wi-Fi change) is never reused. This is what prevents the minutes-long hang + ECONNRESET.
    idle_timeout: 20,
    // Recycle every connection after 30 minutes at most.
    max_lifetime: 60 * 30,
  }));
}

export function db() {
  return drizzle(sql(), { schema });
}

/**
 * Throws the pool away and closes its sockets right now, so the next query opens fresh connections.
 * Used when a query stalls on a connection that died silently.
 */
export async function resetSql(): Promise<void> {
  const old = globalForDb.__pg;
  globalForDb.__pg = undefined;
  if (old) await old.end({ timeout: 0 }).catch(() => {});
}
