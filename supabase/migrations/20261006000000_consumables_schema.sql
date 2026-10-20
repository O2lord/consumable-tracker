-- Phase 0: create the tracker's own schema and lock it down.
-- Only the server (Postgres role / service_role) touches these tables.
-- The `consumables` schema is deliberately NOT added to the Supabase API's exposed schemas.

create schema if not exists consumables;

revoke all on schema consumables from public, anon, authenticated;

grant usage on schema consumables to service_role;

alter default privileges in schema consumables revoke all on tables from anon, authenticated;
alter default privileges in schema consumables revoke all on sequences from anon, authenticated;
alter default privileges in schema consumables grant all on tables to service_role;
alter default privileges in schema consumables grant all on sequences to service_role;

-- Tiny table used by /api/health to prove the schema is reachable.
create table consumables.app_meta (
  key text primary key,
  value text not null,
  created_at timestamptz not null default now()
);

-- RLS on, no policies: deny by default for anything that is not a superuser/service role.
alter table consumables.app_meta enable row level security;

insert into consumables.app_meta (key, value) values ('schema_version', '0');
