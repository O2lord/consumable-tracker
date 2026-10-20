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
  }));
}

export function db() {
  return drizzle(sql(), { schema });
}
