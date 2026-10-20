-- Phase 4 / M4: reports. Read-only views and one function over the ledger; no tables, no data changes.
-- Server-only access like everything else in this schema: security_invoker views, nothing exposed.

-- ---------------------------------------------------------------------------
-- location_reconciliation(p_from, p_to): per location and item type, what came in, what went out
-- and where it ended up, for a period, for SERIAL and QUANTITY items alike.
--
-- Everything is derived from the append-only ledger. Each event has a "shelf effect" (delta) on the
-- location where it happened:
--   +  STOCKED, RECEIVED, FOUND, RETURNED_UNUSED, ADJUSTED
--   -  DISPATCHED, ISSUED, a VOIDED unit that was on the shelf (from_state IN_STOCK), and a WASTED
--      quantity that did not come back through a return (payload.source <> 'RETURN')
--   0  everything else (RETURNED, MISSING_IN_TRANSIT, WRITTEN_OFF, a voided issued unit, ...)
-- This is the same arithmetic as v_quantity_balance, applied to serialized units too.
--
-- opening / closing are the ledger balance before p_from / before p_to. The flow columns count
-- events recorded in [p_from, p_to). "unaccounted" only exists for SERIAL items: it is the number of
-- units actually IN_STOCK at the location now (the units table) minus the ledger balance now. Zero
-- means the units table and the ledger agree; anything else means a unit's state or location was
-- changed without an event. QUANTITY items have no independent count to compare with (only the
-- ledger), so their unaccounted is null until physical stock counts exist.
-- ---------------------------------------------------------------------------
create or replace function consumables.location_reconciliation(p_from timestamptz, p_to timestamptz)
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
  unaccounted integer
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
        when e.type in ('DISPATCHED', 'ISSUED') then -e.quantity
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
    case when it.tracking_mode = 'SERIAL' then coalesce(ac.n, 0) - a.on_hand_now::integer end
  from agg a
  join consumables.locations l on l.id = a.location_id
  join consumables.item_types it on it.id = a.item_type_id
  left join actual ac on ac.location_id = a.location_id and ac.item_type_id = a.item_type_id
  order by l.name, it.name
$$;

-- ---------------------------------------------------------------------------
-- v_outstanding_issued: serialized units still ISSUED, with how long they have been out. The report
-- filters on OUTSTANDING_HOURS (default 24); the view lists them all.
-- ---------------------------------------------------------------------------
create view consumables.v_outstanding_issued with (security_invoker = true) as
select
  u.id as unit_id,
  u.serial,
  it.name as item_name,
  u.current_location_id as location_id,
  l.name as location_name,
  ie.recorded_at as issued_at,
  round((extract(epoch from (now() - ie.recorded_at)) / 3600.0)::numeric, 1) as hours_out,
  (
    select string_agg(k.reference_type || ' ' || k.reference_ref, ', ' order by k.created_at)
    from consumables.links k
    where k.unit_id = u.id and k.cleared_at is null
  ) as issued_for,
  (
    select max(k.patient_hospital_no)
    from consumables.links k
    where k.unit_id = u.id and k.cleared_at is null
  ) as patient_hospital_no
from consumables.units u
join consumables.item_types it on it.id = u.item_type_id
join consumables.locations l on l.id = u.current_location_id
join lateral (
  select e.recorded_at
  from consumables.events e
  where e.unit_id = u.id and e.type = 'ISSUED'
  order by e.recorded_at desc, e.occurred_at desc
  limit 1
) ie on true
where u.state = 'ISSUED';

-- ---------------------------------------------------------------------------
-- v_unverified_issues: links whose payment could not be checked when the item was issued.
-- v_issue_overrides: links a supervisor pushed through past a block, with the reason.
-- ---------------------------------------------------------------------------
create view consumables.v_unverified_issues with (security_invoker = true) as
select
  k.id as link_id,
  k.reference_type,
  k.reference_ref,
  k.test_code,
  k.patient_hospital_no,
  k.patient_type,
  k.quantity,
  coalesce(u.serial, b.code) as item_ref,
  it.name as item_name,
  k.location_id,
  l.name as location_name,
  k.issued_by,
  us.name as issued_by_name,
  k.created_at as issued_at,
  k.cleared_at
from consumables.links k
join consumables.batches b on b.id = k.batch_id
join consumables.item_types it on it.id = b.item_type_id
join consumables.locations l on l.id = k.location_id
join consumables.users us on us.id = k.issued_by
left join consumables.units u on u.id = k.unit_id
where k.payment_check = 'UNVERIFIED';

create view consumables.v_issue_overrides with (security_invoker = true) as
select
  k.id as link_id,
  k.reference_type,
  k.reference_ref,
  k.patient_hospital_no,
  k.quantity,
  coalesce(u.serial, b.code) as item_ref,
  it.name as item_name,
  l.name as location_name,
  us.name as issued_by_name,
  ov.name as override_by_name,
  k.override_reason,
  k.created_at as issued_at
from consumables.links k
join consumables.batches b on b.id = k.batch_id
join consumables.item_types it on it.id = b.item_type_id
join consumables.locations l on l.id = k.location_id
join consumables.users us on us.id = k.issued_by
join consumables.users ov on ov.id = k.override_by
left join consumables.units u on u.id = k.unit_id
where k.override_by is not null;

-- ---------------------------------------------------------------------------
-- v_unit_ledger_mismatch: units whose current state is not what their latest ledger event says
-- (or that have no events at all). On clean data this is empty; a row means a unit was changed
-- without going through a service that writes the event.
-- ---------------------------------------------------------------------------
create view consumables.v_unit_ledger_mismatch with (security_invoker = true) as
select
  u.id as unit_id,
  u.serial,
  it.name as item_name,
  u.state as unit_state,
  le.to_state as ledger_state,
  le.type as last_event_type,
  le.recorded_at as last_event_at,
  l.name as location_name
from consumables.units u
join consumables.item_types it on it.id = u.item_type_id
join consumables.locations l on l.id = u.current_location_id
left join lateral (
  select e.to_state, e.type, e.recorded_at
  from consumables.events e
  where e.unit_id = u.id
  order by e.recorded_at desc, e.occurred_at desc
  limit 1
) le on true
where le.to_state is distinct from u.state;
