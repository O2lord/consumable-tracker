-- Chrome extension (side panel on the staff portal): issues and returns bottles from the investigation
-- page the attendant already has open. Links created that way record reference_source = 'extension',
-- so reports can tell screen-read references apart from typed (manual) and imported (csv) ones.

alter table consumables.links drop constraint links_reference_source_check;
alter table consumables.links add constraint links_reference_source_check
  check (reference_source in ('manual', 'slip_scan', 'csv', 'emr', 'extension'));
