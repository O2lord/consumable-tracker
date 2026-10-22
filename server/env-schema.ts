import { z } from "zod";

// Pure (no server-only import) so it can be unit-tested. Use env() from ./env in app code.
const schema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  SUPABASE_URL: z.string().optional(),
  SUPABASE_ANON_KEY: z.string().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  SESSION_SECRET: z.string().optional(),
  PRINTER_HOST: z.string().optional(),
  // A USB label printer's local queue name; labels go to it as TSPL. Takes priority over PRINTER_HOST when set.
  PRINTER_QUEUE: z.string().optional(),
  // The staff portal's address, used for "View result" links to an investigation (<this>/lab-tests/<id>).
  PORTAL_BASE_URL: z.string().url().default("https://uath-staff-staging.betacare.com.ng"),
  OUTSTANDING_HOURS: z.coerce.number().positive().default(24),
  // Where investigations are looked up: the imported files (csv, the default) or format checks only (manual).
  REFERENCE_PROVIDER: z.enum(["csv", "manual"]).default("csv"),
});

export type Env = z.infer<typeof schema>;

export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = schema.safeParse(source);
  if (!result.success) {
    const problems = result.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid environment: ${problems}`);
  }
  return result.data;
}
