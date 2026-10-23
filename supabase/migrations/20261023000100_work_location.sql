-- The location a supervisor or admin is working at, set once from the app bar and used on every page.
--
-- Only people allowed to work at any location (the work_any_location permission) can choose it; everyone else
-- always works at their home location, so for them this column is never read. Null means "my home location".
-- It is stored here rather than in the browser so the Chrome extension, which signs in with a token and has no
-- cookie, and every tab and device agree on where the person is working.

alter table consumables.users
  add column work_location_id uuid references consumables.locations (id);
