-- Chrome extension: what the portal shows about an investigation's progress, kept so that scanning a bottle
-- can show its journey and each test's status without opening the portal.
--
--   portal_id                  the portal's own id for the investigation (its address is /lab-tests/<id>), so
--                              the panel can open that page
--   portal_started_at/by       when sample work started, and who
--   portal_prepared_at/by      when results were prepared, and who
--   portal_verified_at/by      when results were verified (released), and who
--   portal_completed_at        when the investigation was completed
--
-- Times and staff names only. The results themselves (values, remarks, interpretations) are clinical data
-- and are deliberately NOT stored here: the panel links to the portal's Results tab instead.

alter table consumables.investigation_imports
  add column portal_id text,
  add column portal_started_at timestamptz,
  add column portal_started_by text,
  add column portal_prepared_at timestamptz,
  add column portal_prepared_by text,
  add column portal_verified_at timestamptz,
  add column portal_verified_by text,
  add column portal_completed_at timestamptz;
