-- Batch parts: when one batch is sent in pieces, each piece is a lettered part (A, B, C ...).
--
-- A transfer has exactly one destination, so "6 to Fast Track, 2 to EPU, 2 to A&E" from one box is
-- three transfers. This table gives each (batch, transfer) pair its letter, in dispatch order:
--   BT7K2M9QXR4 part A -> Fast Track,  part B -> EPU,  part C -> A&E
--
-- Rules:
--   * The letter is assigned when the transfer is CONFIRMED (dispatched), never on a draft, so a
--     cancelled draft never uses up a letter.
--   * The service locks the batch row before assigning, so two simultaneous dispatches cannot both
--     get the same letter. The unique constraint below is the backstop.
--   * Letters run A..Z, then AA, AB, ... (spreadsheet style).
--   * A batch sent whole in one transfer simply has one part, A.
--
-- Same rules as the other tables: server-only access, RLS on with no policies.

create table consumables.transfer_batch_parts (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references consumables.batches (id),
  transfer_id uuid not null references consumables.transfers (id) on delete restrict,
  part_letter text not null check (part_letter ~ '^[A-Z]{1,3}$'),
  created_at timestamptz not null default now(),
  constraint transfer_batch_parts_batch_letter_uq unique (batch_id, part_letter),
  constraint transfer_batch_parts_batch_transfer_uq unique (batch_id, transfer_id)
);
create index transfer_batch_parts_transfer_idx on consumables.transfer_batch_parts (transfer_id);

alter table consumables.transfer_batch_parts enable row level security;

-- ---------------------------------------------------------------------------
-- Backfill: give every batch already dispatched its parts, oldest dispatch first.
-- Supports up to 702 parts per batch (A..Z, AA..ZZ), far beyond any real box.
-- ---------------------------------------------------------------------------
insert into consumables.transfer_batch_parts (batch_id, transfer_id, part_letter, created_at)
select
  ranked.batch_id,
  ranked.transfer_id,
  case
    when ranked.n <= 26 then chr(64 + ranked.n)
    else chr(64 + (ranked.n - 1) / 26) || chr(65 + (ranked.n - 1) % 26)
  end,
  ranked.dispatched_at
from (
  select
    pairs.batch_id,
    pairs.transfer_id,
    pairs.dispatched_at,
    row_number() over (partition by pairs.batch_id order by pairs.dispatched_at, pairs.transfer_id)::int as n
  from (
    select distinct
      coalesce(ti.batch_id, u.batch_id) as batch_id,
      t.id as transfer_id,
      t.dispatched_at
    from consumables.transfer_items ti
    join consumables.transfers t on t.id = ti.transfer_id
    left join consumables.units u on u.id = ti.unit_id
    where t.dispatched_at is not null
      and t.status <> 'CANCELLED'
  ) pairs
) ranked;
