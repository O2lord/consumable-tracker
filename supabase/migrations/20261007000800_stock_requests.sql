-- Stock requests: a lab (or any location) asks the store for consumables.
--
-- A request names one item type and a quantity. The store keeper sees every open request and either
-- fulfils it (optionally pointing at the transfer that sent the stock) or declines it with a reason; the
-- person who asked can cancel it while it is still open. Requests do not move stock themselves, so they
-- are not events: the transfer is what moves it. Same rules as before: server-only access, RLS on with
-- no policies.
create table consumables.stock_requests (
  id uuid primary key default gen_random_uuid(),
  -- Printed and quoted on screen, for example REQ7K2M9QXR4.
  code text not null unique,
  -- Where the stock is wanted, and the store it is asked of.
  requesting_location_id uuid not null references consumables.locations (id),
  store_location_id uuid not null references consumables.locations (id),
  item_type_id uuid not null references consumables.item_types (id),
  quantity integer not null check (quantity > 0 and quantity <= 1000000),
  urgency text not null default 'NORMAL' check (urgency in ('NORMAL', 'URGENT')),
  needed_by date,
  note text,
  status text not null default 'OPEN' check (status in ('OPEN', 'FULFILLED', 'DECLINED', 'CANCELLED')),
  requested_by uuid not null references consumables.users (id),
  -- Set when the request is closed: the store's reply (required when declining), who closed it, and the
  -- transfer that fulfilled it, if one was named.
  response_note text,
  closed_by uuid references consumables.users (id),
  closed_at timestamptz,
  transfer_id uuid references consumables.transfers (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (requesting_location_id <> store_location_id)
);
create index stock_requests_status_idx on consumables.stock_requests (status, created_at desc);
create index stock_requests_requesting_idx on consumables.stock_requests (requesting_location_id, created_at desc);
create index stock_requests_store_idx on consumables.stock_requests (store_location_id, status);

alter table consumables.stock_requests enable row level security;
