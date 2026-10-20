-- Phase 6 / M6 (second slice): Pharmacy exports and the mismatch views.
-- Same rules as before: server-only access, RLS on with no policies.
--
-- The tracker defines the import standard (architecture section 9); the Pharmacy exports to fit it.
-- Rows are upserted by a natural key (below), so a later export updates the quantity or status of a
-- row already loaded. Nothing is deleted by an import. The original row is kept in `raw`.

-- sync_log.kind: allow the three Pharmacy imports next to INVESTIGATIONS.
alter table consumables.sync_log drop constraint sync_log_kind_check;
alter table consumables.sync_log add constraint sync_log_kind_check
  check (kind in ('INVESTIGATIONS', 'PHARMACY_INVENTORY', 'PHARMACY_GRN', 'PHARMACY_TRANSFERS'));

-- ---------------------------------------------------------------------------
-- norm_text: lower-case letters and digits only, so "Bat-342", "BAT 342" and "bat342" compare equal,
-- and "Main Store" matches "MAIN-STORE". Used for batch numbers and location names.
-- ---------------------------------------------------------------------------
create function consumables.norm_text(p text) returns text
language sql immutable as $$
  select regexp_replace(lower(coalesce(p, '')), '[^a-z0-9]', '', 'g')
$$;

-- ---------------------------------------------------------------------------
-- pharmacy_imports: one row per Pharmacy line, of three kinds.
--   INVENTORY  stock on hand of one batch at one location. natural_key: location | item | batch.
--              The export has no location column, so the upload says which tracker location it is for.
--   GRN_LINE   one line of a goods received note. natural_key: GRN number | item | batch.
--   TRANSFER   one Pharmacy transfer (totals only; the export has no batch lines).
--              natural_key: the Pharmacy transfer id when the file has one, otherwise
--              type | from | to | requested at | requester.
--              location_label is always where the stock came FROM and destination_label where it went
--              TO: a "request" (the destination asked the location to send) is flipped on import.
-- ---------------------------------------------------------------------------
create table consumables.pharmacy_imports (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('INVENTORY', 'GRN_LINE', 'TRANSFER')),
  natural_key text not null,
  pharmacy_ref text,
  location_id uuid references consumables.locations (id),
  location_label text,
  destination_label text,
  generic_name text,
  strength text,
  brand text,
  item_label text,
  item_key text,
  batch_no text,
  expiry_date date,
  quantity integer not null check (quantity >= 0),
  unit_cost numeric(14, 2),
  unit text,
  category text,
  supplier text,
  transfer_type text,
  status text,
  requested_by text,
  requested_at timestamptz,
  lines integer check (lines is null or lines >= 0),
  raw jsonb not null default '{}'::jsonb,
  sync_log_id uuid references consumables.sync_log (id),
  imported_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pharmacy_imports_key_uq unique (kind, natural_key)
);
create index pharmacy_imports_location_idx on consumables.pharmacy_imports (location_id, kind);
create index pharmacy_imports_batch_idx on consumables.pharmacy_imports (kind, (consumables.norm_text(batch_no)));
create index pharmacy_imports_ref_idx on consumables.pharmacy_imports (pharmacy_ref) where pharmacy_ref is not null;

create trigger pharmacy_imports_updated_at before update on consumables.pharmacy_imports
  for each row execute function consumables.set_updated_at();

alter table consumables.pharmacy_imports enable row level security;

-- ---------------------------------------------------------------------------
-- v_pharmacy_mismatch: tracker stock versus Pharmacy inventory, per location and batch number.
--   QUANTITY_DIFFERS  both sides have the batch at the location, with different quantities
--   NOT_IN_TRACKER    Pharmacy has stock the tracker has never seen at that location
--   NOT_IN_PHARMACY   the tracker has stock the Pharmacy inventory does not list. Only checked for
--                     locations that have an inventory import, so a location never imported is not flagged.
-- Matching is on the batch number (lot_no on the tracker side), normalised. A tracker batch with no lot
-- number cannot be matched and is left out. Tracker stock is the quantity balance for QUANTITY items
-- plus the IN_STOCK units for SERIAL items; units in transit count for neither location.
-- `difference` is tracker minus Pharmacy.
-- ---------------------------------------------------------------------------
create view consumables.v_pharmacy_mismatch with (security_invoker = true) as
with tracker as (
  select
    x.location_id,
    consumables.norm_text(b.lot_no) as batch_key,
    min(b.lot_no) as batch_no,
    string_agg(distinct it.name, ', ') as item_name,
    sum(x.qty)::int as qty
  from (
    select q.batch_id, q.location_id, q.on_hand as qty
    from consumables.v_quantity_balance q
    union all
    select u.batch_id, u.current_location_id, count(*)::int
    from consumables.units u
    where u.state = 'IN_STOCK'
    group by u.batch_id, u.current_location_id
  ) x
  join consumables.batches b on b.id = x.batch_id
  join consumables.item_types it on it.id = b.item_type_id
  where b.lot_no is not null and consumables.norm_text(b.lot_no) <> '' and x.qty <> 0
  group by x.location_id, consumables.norm_text(b.lot_no)
),
pharmacy as (
  select
    p.location_id,
    consumables.norm_text(p.batch_no) as batch_key,
    min(p.batch_no) as batch_no,
    string_agg(distinct p.item_label, ', ') as item_label,
    sum(p.quantity)::int as qty,
    max(p.imported_at) as imported_at
  from consumables.pharmacy_imports p
  where p.kind = 'INVENTORY'
    and p.location_id is not null
    and p.batch_no is not null
    and consumables.norm_text(p.batch_no) <> ''
  group by p.location_id, consumables.norm_text(p.batch_no)
),
covered as (
  select distinct location_id from pharmacy
)
select
  case
    when t.location_id is null then 'NOT_IN_TRACKER'
    when p.location_id is null then 'NOT_IN_PHARMACY'
    else 'QUANTITY_DIFFERS'
  end as problem,
  loc.id as location_id,
  loc.name as location_name,
  coalesce(p.batch_no, t.batch_no) as batch_no,
  p.item_label as pharmacy_item,
  t.item_name as tracker_item,
  p.qty as pharmacy_quantity,
  t.qty as tracker_quantity,
  coalesce(t.qty, 0) - coalesce(p.qty, 0) as difference,
  p.imported_at as pharmacy_imported_at
from pharmacy p
full join tracker t on t.location_id = p.location_id and t.batch_key = p.batch_key
join consumables.locations loc on loc.id = coalesce(p.location_id, t.location_id)
where (p.location_id is not null or t.location_id in (select location_id from covered))
  and coalesce(p.qty, 0) <> coalesce(t.qty, 0);

-- ---------------------------------------------------------------------------
-- v_pharmacy_transfer_check: tracker transfers against imported Pharmacy transfers, by total quantity.
-- The Pharmacy transfer export has no transfer id and no batch lines, so a tracker transfer is paired with
-- an imported one by: the id typed on the tracker transfer (pharmacy_transfer_id) when it has one,
-- otherwise the same from and to location and a Pharmacy request time within a day of the dispatch
-- (the closest wins). Location names are matched to the tracker's name, code or external id.
--   QUANTITY_DIFFERS       paired, but the scanned total differs from the Pharmacy quantity
--   NO_PHARMACY_TRANSFER   a dispatched tracker transfer with no Pharmacy transfer found
--   NO_TRACKER_TRANSFER    a Pharmacy transfer between known locations with no tracker transfer
--   UNMAPPED_LOCATION      a Pharmacy transfer whose location names match no tracker location
--   OK                     paired and the totals agree (the report page leaves these out)
-- `difference` is tracker minus Pharmacy.
-- ---------------------------------------------------------------------------
create view consumables.v_pharmacy_transfer_check with (security_invoker = true) as
with tr as (
  select
    t.id,
    t.code,
    t.status,
    t.pharmacy_transfer_id,
    t.dispatched_at,
    t.from_location_id,
    t.to_location_id,
    fl.name as from_name,
    tl.name as to_name,
    coalesce((
      select sum(ti.quantity_dispatched) from consumables.transfer_items ti where ti.transfer_id = t.id
    ), 0)::int as tracker_quantity
  from consumables.transfers t
  join consumables.locations fl on fl.id = t.from_location_id
  join consumables.locations tl on tl.id = t.to_location_id
  where t.status not in ('DRAFT', 'CANCELLED')
),
ph as (
  select
    p.id,
    p.pharmacy_ref,
    p.status,
    p.requested_by,
    p.requested_at,
    p.quantity,
    p.location_label,
    p.destination_label,
    (
      select l.id from consumables.locations l
      where consumables.norm_text(p.location_label) <> ''
        and consumables.norm_text(p.location_label) in (
          consumables.norm_text(l.name), consumables.norm_text(l.code), consumables.norm_text(l.external_id)
        )
      order by l.active desc, l.name
      limit 1
    ) as from_location_id,
    (
      select l.id from consumables.locations l
      where consumables.norm_text(p.destination_label) <> ''
        and consumables.norm_text(p.destination_label) in (
          consumables.norm_text(l.name), consumables.norm_text(l.code), consumables.norm_text(l.external_id)
        )
      order by l.active desc, l.name
      limit 1
    ) as to_location_id
  from consumables.pharmacy_imports p
  where p.kind = 'TRANSFER'
),
matched as (
  select tr.*, cand.id as pharmacy_import_id
  from tr
  left join lateral (
    select ph.id
    from ph
    where (tr.pharmacy_transfer_id is not null and ph.pharmacy_ref = tr.pharmacy_transfer_id)
       or (
         tr.pharmacy_transfer_id is null
         and ph.from_location_id = tr.from_location_id
         and ph.to_location_id = tr.to_location_id
         and ph.requested_at is not null
         and tr.dispatched_at is not null
         and abs(extract(epoch from (ph.requested_at - tr.dispatched_at))) <= 86400
       )
    order by abs(extract(epoch from (ph.requested_at - tr.dispatched_at))) nulls last
    limit 1
  ) cand on true
)
select
  case
    when m.pharmacy_import_id is null then 'NO_PHARMACY_TRANSFER'
    when m.tracker_quantity <> p.quantity then 'QUANTITY_DIFFERS'
    else 'OK'
  end as problem,
  m.code as tracker_code,
  m.status as tracker_status,
  m.from_name as from_label,
  m.to_name as to_label,
  m.dispatched_at,
  m.tracker_quantity,
  p.id as pharmacy_import_id,
  p.pharmacy_ref,
  p.status as pharmacy_status,
  p.requested_by as pharmacy_requested_by,
  p.requested_at as pharmacy_requested_at,
  p.quantity as pharmacy_quantity,
  case when p.id is null then null else m.tracker_quantity - p.quantity end as difference,
  coalesce(m.dispatched_at, p.requested_at) as sort_at
from matched m
left join ph p on p.id = m.pharmacy_import_id
union all
select
  case
    when p.from_location_id is null or p.to_location_id is null then 'UNMAPPED_LOCATION'
    else 'NO_TRACKER_TRANSFER'
  end,
  null::text,
  null::text,
  p.location_label,
  p.destination_label,
  null::timestamptz,
  null::int,
  p.id,
  p.pharmacy_ref,
  p.status,
  p.requested_by,
  p.requested_at,
  p.quantity,
  null::int,
  p.requested_at
from ph p
where not exists (select 1 from matched m where m.pharmacy_import_id = p.id);
