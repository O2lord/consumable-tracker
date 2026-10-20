import "server-only";
import { parseEnv, type Env } from "./env-schema";

let cached: Env | undefined;

/** Validated server environment, parsed once on first use. */
export function env(): Env {
  cached ??= parseEnv(process.env);
  return cached;
}
