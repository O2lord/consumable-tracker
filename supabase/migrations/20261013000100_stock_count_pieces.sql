-- Stock counts can now count loose pieces as well as sealed packs.
--
-- Until now a count covered sealed packs only (v_quantity_balance). A location can also hold loose pieces of a
-- batch (v_loose_pieces: an opened pack, or pieces received in a transfer counted in pieces). Those could never
-- be counted, so a batch that held only loose pieces did not appear on the count sheet at all.
--
-- A count line now carries two independent figures, each optional:
--   * sealed packs: counted_quantity / expected_quantity (counted_quantity is now nullable: null = packs not counted)
--   * loose pieces: counted_pieces / expected_pieces     (counted_pieces is nullable: null = pieces not counted)
-- At least one of the two must be counted. Each figure has its own variance, its own reason and its own
-- ADJUSTED event when it is posted.
--
-- Posting a piece variance: an ADJUSTED event with quantity 0 and pieces = the size of the variance. events.pieces
-- cannot be negative, so the direction travels in the payload (piecesDirection = 'ADD' | 'REMOVE') and
-- v_loose_pieces reads it. Piece events have quantity 0, so v_quantity_balance and the reconciliation report
-- are not affected.

alter table consumables.stock_count_lines
  alter column counted_quantity drop not null;

alter table consumables.stock_count_lines
  add column counted_pieces integer check (counted_pieces is null or (counted_pieces >= 0 and counted_pieces <= 10000000)),
  add column expected_pieces integer not null default 0,
  add column pieces_reason_code text,
  add column pieces_note text,
  add column pieces_adjustment_event_id uuid references consumables.events (id),
  add constraint stock_count_lines_something_counted check (counted_quantity is not null or counted_pieces is not null);

-- v_loose_pieces: same columns as before. The only change is that an ADJUSTED event (a stock count correction)
-- adds pieces, or removes them when its payload says REMOVE.
create or replace view consumables.v_loose_pieces with (security_invoker = true) as
select
  e.batch_id,
  e.location_id,
  sum(
    case
      when e.type in ('OPENED', 'RECEIVED', 'FOUND') then e.pieces
      when e.type = 'DISPATCHED' then -e.pieces
      when e.type = 'ADJUSTED' and coalesce(e.payload ->> 'piecesDirection', '') = 'REMOVE' then -e.pieces
      when e.type = 'ADJUSTED' then e.pieces
      else 0
    end
  )::int as loose
from consumables.events e
where e.unit_id is null and e.batch_id is not null and e.pieces > 0
group by e.batch_id, e.location_id;
