-- Chrome extension (side panel on the staff portal): keeps an imported investigation's status and invoice
-- number current from the portal page the attendant has open.
--
--   invoice_number     the portal's invoice number for the investigation (null when it has none, for
--                      example inpatient investigations that are charged to the admission)
--   portal_synced_at   when the extension last changed this row's status or invoice number
--   portal_synced_by   who had the portal open at the time
--
-- Only these two values are ever written from the portal, and only on a row an import already created.
-- Payment is deliberately NOT written here: it stays whatever the EMR import says, so a figure read off a
-- screen can never become the "verified" payment that other flows trust.

alter table consumables.investigation_imports
  add column invoice_number text,
  add column portal_synced_at timestamptz,
  add column portal_synced_by uuid references consumables.users (id);
