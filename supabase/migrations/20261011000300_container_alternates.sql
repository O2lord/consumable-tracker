-- Fit to the hospital's consumables list (corrections.md, C4).
--
-- A test names one required container, but the hospital stocks both plain and gel tubes and many
-- chemistry tests can use either. alternate_container_types lists the other containers that also
-- satisfy the test. A test is satisfied by its required container or any alternate.
--
-- An empty list means "no alternates", so every existing row behaves exactly as before. Alternates
-- only mean something when required_container_type is set (a test with no required container
-- accepts any container already), and the app strips a repeat of the required type.

alter table consumables.test_catalog
  add column alternate_container_types text[] not null default '{}';
