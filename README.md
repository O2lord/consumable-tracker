# Consumables Barcode Tracker

Tracks hospital consumables (starting with sample bottles) from the main store to the point of use, with full accountability at every step.

- `architecture.md`: what the system is and why
- `build.md`: phased build plan and progress tracker

## Stack

Next.js (App Router) + TypeScript, Supabase Postgres, Drizzle ORM over `postgres.js`, Zod, Vitest, Playwright.

**Data access decision:** the server talks to Postgres directly (Drizzle + the Supabase connection string) instead of through the Supabase REST API. The ledger needs real multi-statement transactions ("every state change writes exactly one event in the same transaction"), which the REST API cannot do. Supabase CLI owns the migrations (`supabase/migrations/*.sql`); `src/server/db/schema.ts` mirrors the tables for typed queries and must be kept in sync with them. The `consumables` schema is not exposed through the Supabase API.

## Setup

Prerequisites: Node 22+, Docker (for the local Supabase stack).

```bash
npm install

# one-time: creates supabase/config.toml (existing migrations are kept)
npx supabase init

# start local Postgres/Auth/Studio in Docker and apply migrations
npm run db:start
npm run db:reset

cp .env.example .env.local   # then fill in values
npm run dev
```

Check it works: `http://localhost:3000/api/health` should return `{"ok":true,"database":"reachable","schemaVersion":"0"}`.

### Hosted Supabase (dev project)

```bash
npx supabase login
npx supabase link --project-ref <your-project-ref>
npm run db:push
```

Then put the project's connection string in `DATABASE_URL`. Use the pooled (transaction) string on port 6543 for a deployed app. Use separate Supabase projects for dev and production.

## Environment variables

See `.env.example`. All are server-only; none may be prefixed `NEXT_PUBLIC_`.

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string (required) |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | Supabase API and auth (used from Phase 1) |
| `SESSION_SECRET` | Session/cookie signing |
| `PRINTER_HOST` | ZPL label printer; empty means PDF fallback |
| `OUTSTANDING_HOURS` | Hours before an issued bottle counts as outstanding (default 24) |

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` / `build` / `start` | Next.js |
| `npm run lint` | ESLint |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Vitest (unit and integration) |
| `npm run test:e2e` | Playwright (needs a running database) |
| `npm run format` | Prettier |
| `npm run db:start` / `db:stop` / `db:reset` | Local Supabase stack |
| `npm run db:new <name>` | New SQL migration |
| `npm run db:push` | Apply migrations to the linked hosted project |

## Project layout

See section 6 of `architecture.md`. Source lives at the repo root (`app/`, `components/`, `lib/`, `server/`, and so on, with no `src/` folder); the `@/` import alias points to the repo root.
