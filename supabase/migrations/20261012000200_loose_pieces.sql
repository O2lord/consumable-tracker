-- Loose pieces: a pack can be opened and part of it sent on.
--
-- Until now the ledger counted whole packs only. Now a location can hold sealed packs AND loose pieces
-- (an opened pack with some pieces taken out). Example: the store has 10 sealed packs of 100 and sends
-- 20 pieces. One pack is opened (OPENED, -1 sealed pack, +100 loose), then 20 pieces leave
-- (DISPATCHED with quantity 0 and pieces 20). The store now holds 9 sealed packs and 80 loose pieces.
--
-- How it fits the existing ledger:
--   * events.quantity stays a whole number of packs. Every existing report and view keeps adding it up
--     correctly. A piece movement is an event with quantity 0 and pieces > 0, so existing sums ignore it.
--   * events.pieces is new. It is the number of loose pieces an event adds or removes (the sign comes
--     from the event type, the same way it does for quantity).
--   * OPENED is a new event type: quantity = sealed packs opened (they leave the sealed balance),
--     pieces = quantity * pack size (they join the loose pieces).
--   * v_quantity_balance still means SEALED packs. v_loose_pieces is the loose pieces per batch and location.
--   * transfer_items.in_pieces / stock_request_lines.in_pieces say a row's quantities are in pieces
--     (all of them: dispatched, received, missing, found, written off, requested, approved).
--
-- Nothing changes for existing data or for anyone who never uses pieces.

-- ---------------------------------------------------------------------------
-- events: pieces column, and the two checks that assumed whole packs.
-- ---------------------------------------------------------------------------
alter table consumables.events
  add column pieces integer not null default 0 check (pieces >= 0);

-- Drop the old "quantity <> 0" check and the old event type list (both were unnamed in the first migration,
-- so find them by what they say) and put back versions that know about pieces.
do $$
declare
  c record;
begin
  for c in
    select conname, pg_get_constraintdef(oid) as def
    from pg_constraint
    where conrelid = 'consumables.events'::regclass and contype = 'c'
  loop
    if (c.def like '%quantity <> 0%' and c.def not like '%pieces%') or c.def like '%''STOCKED''%' then
      execute format('alter table consumables.events drop constraint %I', c.conname);
    end if;
  end loop;
end $$;

alter table consumables.events
  add constraint events_quantity_or_pieces check (quantity <> 0 or pieces <> 0);

-- Loose pieces only exist for bulk batches, never for a single serialized unit.
alter table consumables.events
  add constraint events_pieces_bulk_only check (pieces = 0 or unit_id is null);

alter table consumables.events
  add constraint events_type_check check (type in (
    'STOCKED', 'DISPATCHED', 'RECEIVED', 'ISSUED', 'USED', 'RETURNED', 'RETURNED_UNUSED',
    'VOIDED', 'WASTED', 'ADJUSTED', 'MISSING_IN_TRANSIT', 'FOUND', 'WRITTEN_OFF', 'OPENED'
  ));

-- ---------------------------------------------------------------------------
-- Rows that count in pieces. Default false, so every existing row keeps meaning "the item's own unit".
-- ---------------------------------------------------------------------------
alter table consumables.transfer_items
  add column in_pieces boolean not null default false,
  add constraint transfer_items_pieces_bulk_only check (not in_pieces or unit_id is null);

alter table consumables.stock_request_lines
  add column in_pieces boolean not null default false;

-- ---------------------------------------------------------------------------
-- v_quantity_balance: sealed packs. Same columns as before; the only change is that opening a pack
-- takes it off the sealed balance (replaces the issue/return/void version).
-- ---------------------------------------------------------------------------
create or replace view consumables.v_quantity_balance with (security_invoker = true) as
select
  e.batch_id,
  b.code as batch_code,
  it.id as item_type_id,
  it.name as item_name,
  e.location_id,
  sum(
    case
      when e.type = 'STOCKED' then e.quantity
      when e.type = 'RECEIVED' then e.quantity
      when e.type = 'FOUND' then e.quantity
      when e.type = 'DISPATCHED' then -e.quantity
      when e.type = 'ADJUSTED' then e.quantity
      when e.type = 'ISSUED' then -e.quantity
      when e.type = 'RETURNED_UNUSED' then e.quantity
      when e.type = 'OPENED' then -e.quantity
      when e.type = 'WASTED' and coalesce(e.payload ->> 'source', '') <> 'RETURN' then -e.quantity
      else 0
    end
  )::int as on_hand
from consumables.events e
join consumables.batches b on b.id = e.batch_id
join consumables.item_types it on it.id = b.item_type_id
where e.unit_id is null and e.batch_id is not null
group by e.batch_id, b.code, it.id, it.name, e.location_id;

-- ---------------------------------------------------------------------------
-- v_loose_pieces: loose pieces per batch per location.
--   +  OPENED (the pieces of the pack that was opened), RECEIVED, FOUND
--   -  DISPATCHED
-- MISSING_IN_TRANSIT and WRITTEN_OFF change nothing here, the same as they change nothing in
-- v_quantity_balance: the pieces already left when they were dispatched.
-- ---------------------------------------------------------------------------
create view consumables.v_loose_pieces with (security_invoker = true) as
select
  e.batch_id,
  e.location_id,
  sum(
    case
      when e.type in ('OPENED', 'RECEIVED', 'FOUND') then e.pieces
      when e.type = 'DISPATCHED' then -e.pieces
      else 0
    end
  )::int as loose
from consumables.events e
where e.unit_id is null and e.batch_id is not null and e.pieces > 0
group by e.batch_id, e.location_id;

-- ---------------------------------------------------------------------------
-- location_reconciliation: the same function plus an `opened` column (sealed packs opened in the
-- period). Opening a pack takes it off the shelf in the pack count, so closing stays equal to
-- v_quantity_balance. Piece events have quantity 0, so none of the other columns move.
-- Return type changes (a new column), so the function is dropped and recreated.
-- ---------------------------------------------------------------------------
drop function consumables.location_reconciliation(timestamptz, timestamptz);

create function consumables.location_reconciliation(p_from timestamptz, p_to timestamptz)
returns table (
  location_id uuid,
  location_name text,
  item_type_id uuid,
  item_name text,
  tracking_mode consumables.tracking_mode,
  opening integer,
  stocked integer,
  received integer,
  found integer,
  dispatched integer,
  issued integer,
  returned_used integer,
  restocked integer,
  voided_or_wasted integer,
  missing integer,
  closing integer,
  on_hand_now integer,
  actual_in_stock integer,
  unaccounted integer,
  opened integer
)
language sql
stable
as $$
  with deltas as (
    select
      e.location_id,
      it.id as item_type_id,
      e.type,
      e.quantity,
      e.recorded_at,
      case
        when e.type in ('STOCKED', 'RECEIVED', 'FOUND', 'RETURNED_UNUSED', 'ADJUSTED') then e.quantity
        when e.type in ('DISPATCHED', 'ISSUED', 'OPENED') then -e.quantity
        when e.type = 'VOIDED' and e.from_state = 'IN_STOCK' then -e.quantity
        when e.type = 'WASTED' and coalesce(e.payload ->> 'source', '') <> 'RETURN' then -e.quantity
        else 0
      end as delta
    from consumables.events e
    join consumables.batches b on b.id = e.batch_id
    join consumables.item_types it on it.id = b.item_type_id
    where e.batch_id is not null
  ),
  agg as (
    select
      d.location_id,
      d.item_type_id,
      coalesce(sum(d.delta) filter (where d.recorded_at < p_from), 0) as opening,
      coalesce(sum(d.quantity) filter (where d.type = 'STOCKED' and d.recorded_at >= p_from and d.recorded_at < p_to), 0) as stocked,
      coalesce(sum(d.quantity) filter (where d.type = 'RECEIVED' and d.recorded_at >= p_from and d.recorded_at < p_to), 0) as received,
      coalesce(sum(d.quantity) filter (where d.type = 'FOUND' and d.recorded_at >= p_from and d.recorded_at < p_to), 0) as found,
      coalesce(sum(d.quantity) filter (where d.type = 'DISPATCHED' and d.recorded_at >= p_from and d.recorded_at < p_to), 0) as dispatched,
      coalesce(sum(d.quantity) filter (where d.type = 'ISSUED' and d.recorded_at >= p_from and d.recorded_at < p_to), 0) as issued,
      coalesce(sum(d.quantity) filter (where d.type = 'RETURNED' and d.recorded_at >= p_from and d.recorded_at < p_to), 0) as returned_used,
      coalesce(sum(d.quantity) filter (where d.type = 'RETURNED_UNUSED' and d.recorded_at >= p_from and d.recorded_at < p_to), 0) as restocked,
      coalesce(sum(d.quantity) filter (where d.type in ('VOIDED', 'WASTED') and d.recorded_at >= p_from and d.recorded_at < p_to), 0) as voided_or_wasted,
      coalesce(sum(d.quantity) filter (where d.type = 'MISSING_IN_TRANSIT' and d.recorded_at >= p_from and d.recorded_at < p_to), 0) as missing,
      coalesce(sum(d.quantity) filter (where d.type = 'OPENED' and d.recorded_at >= p_from and d.recorded_at < p_to), 0) as opened,
      coalesce(sum(d.delta) filter (where d.recorded_at < p_to), 0) as closing,
      coalesce(sum(d.delta), 0) as on_hand_now
    from deltas d
    group by d.location_id, d.item_type_id
  ),
  actual as (
    select u.current_location_id as location_id, u.item_type_id, count(*)::integer as n
    from consumables.units u
    where u.state = 'IN_STOCK'
    group by u.current_location_id, u.item_type_id
  )
  select
    a.location_id,
    l.name,
    a.item_type_id,
    it.name,
    it.tracking_mode,
    a.opening::integer,
    a.stocked::integer,
    a.received::integer,
    a.found::integer,
    a.dispatched::integer,
    a.issued::integer,
    a.returned_used::integer,
    a.restocked::integer,
    a.voided_or_wasted::integer,
    a.missing::integer,
    a.closing::integer,
    a.on_hand_now::integer,
    case when it.tracking_mode = 'SERIAL' then coalesce(ac.n, 0) end,
    case when it.tracking_mode = 'SERIAL' then coalesce(ac.n, 0) - a.on_hand_now::integer end,
    a.opened::integer
  from agg a
  join consumables.locations l on l.id = a.location_id
  join consumables.item_types it on it.id = a.item_type_id
  left join actual ac on ac.location_id = a.location_id and ac.item_type_id = a.item_type_id
  order by l.name, it.name
$$;
