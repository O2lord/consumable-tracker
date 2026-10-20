-- Used for test: what the lab used at the bench, entered by the lab with no patient ("1 pack cotton wool, 10 AHG").
--
-- It is recorded as a USED event on the ledger. The event type already exists, but until now nothing wrote it and the
-- shelf views ignored it ("counted out at issue"). Now a USED event takes stock off the shelf:
--   * quantity: whole packs or units used (v_quantity_balance)
--   * pieces:   loose pieces used (v_loose_pieces), with quantity 0, the same way a piece issue works
-- USED is deliberately NOT in v_quantity_issued_outstanding, so used stock never shows as "out" and can never be
-- returned: nobody owes the lab anything for it. The ISSUED event stays for items tied to a patient.
--
-- payload.usedOn (the day it was used, which can be earlier than the day it was entered) and payload.section (an
-- optional test or section label such as "Blood bank") live in the event payload. Neither holds personal data.
--
-- Three views and one function change, and one permission is added. Nothing changes for existing data: no USED
-- event exists yet.

-- ---------------------------------------------------------------------------
-- v_quantity_balance: sealed packs. The only change is the USED line.
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
      when e.type = 'USED' then -e.quantity
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
-- v_loose_pieces: same columns as before. The only change is that USED takes pieces off the loose balance.
-- ---------------------------------------------------------------------------
create or replace view consumables.v_loose_pieces with (security_invoker = true) as
select
  e.batch_id,
  e.location_id,
  sum(
    case
      when e.type in ('OPENED', 'RECEIVED', 'FOUND') then e.pieces
      when e.type in ('DISPATCHED', 'ISSUED', 'USED') then -e.pieces
      when e.type = 'ADJUSTED' and coalesce(e.payload ->> 'piecesDirection', '') = 'REMOVE' then -e.pieces
      when e.type = 'ADJUSTED' then e.pieces
      else 0
    end
  )::int as loose
from consumables.events e
where e.unit_id is null and e.batch_id is not null and e.pieces > 0
group by e.batch_id, e.location_id;

-- ---------------------------------------------------------------------------
-- location_reconciliation: the same function plus a `used` column (stock used at the bench in the period). USED
-- takes stock off the shelf, so closing stays equal to v_quantity_balance. Return type changes (a new column), so
-- the function is dropped and recreated. Piece events have quantity 0, so a piece-only entry moves no other column.
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
  opened integer,
  used integer
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
        when e.type in ('DISPATCHED', 'ISSUED', 'USED', 'OPENED') then -e.quantity
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
      coalesce(sum(d.quantity) filter (where d.type = 'USED' and d.recorded_at >= p_from and d.recorded_at < p_to), 0) as used,
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
    a.opened::integer,
    a.used::integer
  from agg a
  join consumables.locations l on l.id = a.location_id
  join consumables.item_types it on it.id = a.item_type_id
  left join actual ac on ac.location_id = a.location_id and ac.item_type_id = a.item_type_id
  order by l.name, it.name
$$;

-- ---------------------------------------------------------------------------
-- A new permission: record what the lab used at the bench (the Used for test screen). It is chosen per role on
-- Admin > Roles, like every other permission.
--
-- The built-in Distributor and Supervisor roles get it, because they are who issue stock today. Custom roles do not
-- have it until an admin ticks it. ADMIN is locked, so its permissions come from the application code; it is updated
-- here only so the stored row matches. The statement is safe to run again.
-- ---------------------------------------------------------------------------
update consumables.roles
set permissions = array_append(permissions, 'record_usage')
where code in ('DISTRIBUTOR', 'SUPERVISOR', 'ADMIN')
  and not ('record_usage' = any (permissions));
