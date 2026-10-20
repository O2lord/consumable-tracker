// Postgres error helpers. Drizzle wraps driver errors, so the SQLSTATE can sit on `cause`.

function sqlState(err: unknown): string | undefined {
  let current: unknown = err;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/** True for a UNIQUE constraint violation (SQLSTATE 23505). */
export function isUniqueViolation(err: unknown): boolean {
  return sqlState(err) === "23505";
}
