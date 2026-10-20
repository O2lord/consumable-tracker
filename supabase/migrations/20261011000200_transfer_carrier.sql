-- C5 (corrections.md): who is carrying the stock, typed by the store keeper at dispatch.
-- Stored on the transfer; each DISPATCHED event already points to its transfer through
-- transfer_id, so the ledger holds no names. Old transfers keep a null value ("Not recorded").

alter table consumables.transfers add column carried_by_name text;

-- Write-once: once set at dispatch, it can't be changed.
create function consumables.transfers_carrier_write_once() returns trigger
language plpgsql as $$
begin
  if old.carried_by_name is not null and new.carried_by_name is distinct from old.carried_by_name then
    raise exception 'carried_by_name cannot be changed once set';
  end if;
  return new;
end;
$$;

create trigger transfers_carrier_write_once before update on consumables.transfers
  for each row execute function consumables.transfers_carrier_write_once();
