-- Fit to the hospital's consumables list (corrections.md, C4): flag the container mapping as unconfirmed.
--
-- The plain/gel mappings are best guesses until the lab has said which tubes each test accepts, so each
-- test carries a flag for "the lab has confirmed this test's container and its alternates". It is shown
-- on the admin Test catalog screen and never blocks anything: the issue check works the same either way.
--
-- Every existing test starts unconfirmed (false). A test with no required container accepts any container,
-- so there is nothing to confirm for it and the screen leaves it out of the count.

alter table consumables.test_catalog
  add column containers_confirmed boolean not null default false;
