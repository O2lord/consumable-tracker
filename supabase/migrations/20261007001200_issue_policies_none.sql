-- Issue policies: payment no longer blocks or flags an issue.
--
-- Investigations now come from the Chrome extension, which reads the staff portal. The EMR itself decides
-- whether a test goes ahead, so the tracker does not judge payment: every rule becomes NONE.
--   - MUST_BE_PAID (outpatient and walk-in investigations) stopped issues when the portal showed Unpaid
--     and recorded UNVERIFIED when payment could not be read. With NONE both stop: new links are recorded
--     as NOT_REQUIRED and nothing is blocked.
--   - CHARGE_TO_ADMISSION never blocked anything, but is set to NONE too so the Issue policies screen
--     tells one simple story.
-- Existing links keep the payment_check they were recorded with; nothing is rewritten.
-- An admin can still change any rule on the Issue policies screen if payment checks are wanted again.

update consumables.issue_policies
set rule = 'NONE'
where rule <> 'NONE';
