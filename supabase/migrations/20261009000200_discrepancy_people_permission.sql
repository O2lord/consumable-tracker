-- A new permission: see who was involved in a discrepancy (who dispatched, received and closed the
-- transfer). It is chosen per role on Admin > Roles, like every other permission.
--
-- The built-in Supervisor and Auditor roles get it so what they could already see stays as complete as
-- the new page allows. Other roles, including custom ones, do not have it until an admin ticks it.
-- ADMIN is locked, so its permissions come from the application code; it is updated here only so the
-- stored row matches. The statement is safe to run again.

update consumables.roles
set permissions = array_append(permissions, 'view_discrepancy_people')
where code in ('SUPERVISOR', 'AUDITOR', 'ADMIN')
  and not ('view_discrepancy_people' = any (permissions));
