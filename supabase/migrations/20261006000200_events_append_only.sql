-- The events table is an append-only ledger: corrections are new events, never edits.
-- Two layers: a trigger that rejects UPDATE/DELETE/TRUNCATE for everyone (including the owner),
-- and revoked privileges for service_role.

create function consumables.events_reject_mutation() returns trigger
language plpgsql as $$
begin
  raise exception 'consumables.events is append-only: % is not allowed', tg_op
    using errcode = 'restrict_violation';
end;
$$;

create trigger events_no_update_delete
  before update or delete on consumables.events
  for each row execute function consumables.events_reject_mutation();

create trigger events_no_truncate
  before truncate on consumables.events
  for each statement execute function consumables.events_reject_mutation();

revoke update, delete, truncate on consumables.events from service_role;
