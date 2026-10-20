-- Stock requests v2: a lab asks the store for item types and quantities; the store approves, adjusts
-- or rejects; approval creates a linked draft transfer. Replaces the single-item table from
-- 20261007000800, which no code ever used.
--
-- Rules (the service enforces them; the checks below are the backstop):
--   * A request has one or more lines, one per item type. Labs ask by item type and quantity; the store
--     picks the batches and bottles at dispatch.
--   * Lifecycle: DRAFT -> SUBMITTED -> APPROVED | REJECTED -> PARTIALLY_FULFILLED -> FULFILLED | CLOSED.
--     A lab can CANCEL while DRAFT or SUBMITTED.
--   * quantity_approved is set at review. quantity_dispatched can never exceed it, and quantity_received
--     can never exceed what was dispatched. The open balance of a line is approved - dispatched.
--   * A line that stays short can be left open (a later transfer fills it) or closed with a reason.
--   * Requests do not move stock. The transfer does.
-- Same rules as the other tables: server-only access, RLS on with no policies.

do $$
begin
  if exists (select 1 from consumables.stock_requests) then
    raise exception 'consumables.stock_requests has rows; migrate them before applying stock_requests_v2';
  end if;
end $$;

drop table consumables.stock_requests;

create table consumables.stock_requests (
  id uuid primary key default gen_random_uuid(),
  -- Printed and quoted on screen, for example REQ7K2M9QXR4.
  code text not null unique,
  requesting_location_id uuid not null references consumables.locations (id),
  store_location_id uuid not null references consumables.locations (id),
  status text not null default 'DRAFT' check (
    status in ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'PARTIALLY_FULFILLED', 'FULFILLED', 'CLOSED', 'CANCELLED')
  ),
  note text,
  requested_by uuid not null references consumables.users (id),
  submitted_at timestamptz,
  reviewed_by uuid references consumables.users (id),
  reviewed_at timestamptz,
  -- The store's reply. Required when rejecting.
  review_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (requesting_location_id <> store_location_id),
  check (status <> 'REJECTED' or (review_note is not null and length(btrim(review_note)) > 0))
);
create index stock_requests_status_idx on consumables.stock_requests (status, created_at desc);
create index stock_requests_requesting_idx on consumables.stock_requests (requesting_location_id, created_at desc);
create index stock_requests_store_idx on consumables.stock_requests (store_location_id, status);

create table consumables.stock_request_lines (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references consumables.stock_requests (id) on delete restrict,
  item_type_id uuid not null references consumables.item_types (id),
  quantity_requested integer not null check (quantity_requested > 0 and quantity_requested <= 1000000),
  -- Null until the store reviews the request. May be 0 (line declined).
  quantity_approved integer check (quantity_approved >= 0 and quantity_approved <= 1000000),
  -- Counted from confirmed (dispatched) transfers linked to the request.
  quantity_dispatched integer not null default 0 check (quantity_dispatched >= 0),
  -- Counted from received quantities on those transfers.
  quantity_received integer not null default 0 check (quantity_received >= 0),
  -- Set when the store gives up on the open balance. A reason is required.
  closed_at timestamptz,
  closed_by uuid references consumables.users (id),
  close_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint stock_request_lines_item_uq unique (request_id, item_type_id),
  check (quantity_approved is null or quantity_dispatched <= quantity_approved),
  check (quantity_received <= quantity_dispatched),
  check (closed_at is null or (close_reason is not null and length(btrim(close_reason)) > 0))
);
create index stock_request_lines_request_idx on consumables.stock_request_lines (request_id);

-- A transfer can trace back to the request it fills. Null for transfers made without a request.
alter table consumables.transfers
  add column request_id uuid references consumables.stock_requests (id);
create index transfers_request_idx on consumables.transfers (request_id) where request_id is not null;

alter table consumables.stock_requests enable row level security;
alter table consumables.stock_request_lines enable row level security;
