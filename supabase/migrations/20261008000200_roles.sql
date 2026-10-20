-- Roles you can edit and add to.
--
-- Until now the five roles were a fixed enum and what each could do was written in the code. Now a role
-- is a row: a stable code, a name admins can change, and the list of things it may do.
--   * The five built-in roles are seeded below with the permissions they always had.
--     Their codes (STORE_KEEPER, DISTRIBUTOR, SUPERVISOR, AUDITOR, ADMIN) never change, so existing
--     users and scripts keep working. Their names and permissions can be edited.
--   * ADMIN is locked: its permissions come from the application code (it always has every
--     administration screen), and it cannot be deleted. That way someone can always manage roles.
--   * Custom roles get a generated code and are managed under Admin > Roles.
-- consumables.users.role stays a column of the same name; it now holds the role's code.

-- The column change below needs a brief exclusive lock on users. If another connection (a running dev
-- server, a stuck session) holds that table, fail after 20 seconds with a clear "lock timeout" instead of
-- waiting out the pooler's short statement timeout.
set lock_timeout = '20s';
set statement_timeout = '2min';

create table consumables.roles (
  code text primary key check (code ~ '^[A-Z][A-Z0-9_]{1,39}$'),
  name text not null check (length(btrim(name)) between 1 and 60),
  description text not null default '',
  permissions text[] not null default '{}',
  locked boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Two roles cannot share a name, ignoring case.
create unique index roles_name_unique on consumables.roles (lower(btrim(name)));

create trigger roles_updated_at before update on consumables.roles
  for each row execute function consumables.set_updated_at();

alter table consumables.roles enable row level security;

insert into consumables.roles (code, name, description, permissions, locked) values
  (
    'STORE_KEEPER', 'Store keeper',
    'Receives deliveries into the store, dispatches to the labs and answers their stock requests.',
    array['view_dashboard','stock_in','dispatch','view_store_reports','view_discrepancies','check_labels','review_requests'],
    false
  ),
  (
    'DISTRIBUTOR', 'Distributor',
    'Works at one location: receives, issues, returns and voids bottles, and requests stock.',
    array['view_dashboard','receive','issue','return','void','view_location_stock','check_labels','create_request'],
    false
  ),
  (
    'SUPERVISOR', 'Supervisor',
    'Everything the store keeper and distributor can do, at any location, plus overrides, resolving discrepancies and all reports.',
    array[
      'view_dashboard','stock_in','dispatch','view_store_reports','view_discrepancies','check_labels','review_requests',
      'receive','issue','return','void','view_location_stock','create_request',
      'resolve_discrepancy','approve_override','view_reports','work_any_location'
    ],
    false
  ),
  (
    'AUDITOR', 'Auditor',
    'Read-only: dashboard, reports and discrepancies.',
    array['view_dashboard','view_reports','view_discrepancies'],
    false
  ),
  (
    'ADMIN', 'Admin',
    'Sees every screen, including administration, and works at any location. Cannot be changed or deleted, so there is always someone who can manage the system.',
    array[
      'view_dashboard','stock_in','dispatch','view_store_reports','view_discrepancies','check_labels',
      'receive','issue','return','void','view_location_stock','create_request','review_requests',
      'view_reports','work_any_location',
      'manage_users','manage_roles','manage_locations','manage_item_types','manage_policies',
      'manage_test_catalog','manage_void_reasons','manage_imports'
    ],
    true
  );

-- users.role: enum -> text, and every value must be a real role.
alter table consumables.users alter column role type text using role::text;
alter table consumables.users
  add constraint users_role_fkey foreign key (role) references consumables.roles (code);
drop type consumables.user_role;
