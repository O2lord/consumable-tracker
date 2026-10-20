-- Issue for a test can now take loose pieces from a pack item.
--
-- A pack item (unit "Pack", pack size above 1) can be issued in pieces, the same way a transfer can already send
-- pieces: loose pieces are used first, and only when they run out is a sealed pack opened (an OPENED event, which
-- takes one sealed pack off v_quantity_balance and adds its pieces to the loose ones). The pieces themselves then
-- leave as an ISSUED event with quantity 0 and pieces > 0, so every existing sum over quantity ignores it.
--
-- Two changes make that work:
--   * v_loose_pieces: an ISSUED event now takes its pieces off the loose balance (before, only DISPATCHED did, so an
--     issue of pieces would never have reduced the loose count).
--   * links.in_pieces: says a link's quantity is loose pieces rather than the item's own unit, the same flag
--     transfer_items and stock_request_lines already carry. links.quantity stays > 0 (it holds the number of pieces).
--
-- Nothing changes for existing data: the flag defaults to false, and no existing ISSUED event has pieces.

alter table consumables.links
  add column in_pieces boolean not null default false,
  add constraint links_pieces_bulk_only check (not in_pieces or unit_id is null);

-- v_loose_pieces: same columns as before. The only change is the ISSUED line.
create or replace view consumables.v_loose_pieces with (security_invoker = true) as
select
  e.batch_id,
  e.location_id,
  sum(
    case
      when e.type in ('OPENED', 'RECEIVED', 'FOUND') then e.pieces
      when e.type in ('DISPATCHED', 'ISSUED') then -e.pieces
      when e.type = 'ADJUSTED' and coalesce(e.payload ->> 'piecesDirection', '') = 'REMOVE' then -e.pieces
      when e.type = 'ADJUSTED' then e.pieces
      else 0
    end
  )::int as loose
from consumables.events e
where e.unit_id is null and e.batch_id is not null and e.pieces > 0
group by e.batch_id, e.location_id;
