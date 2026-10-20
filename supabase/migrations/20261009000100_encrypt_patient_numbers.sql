-- Patient numbers (MRN) are now stored encrypted, with a separate "blind index" for searching.
--
--   patient_hospital_no       holds scrambled text ("enc:v1:..."), written and read by the app
--                             (server/security/field-crypto.ts). The database can no longer read it, compare
--                             it or sort it. The key is in the app's environment, never in this database.
--   patient_hospital_no_idx   an HMAC of the normalised MRN (hex). The same MRN always gives the same value, so
--                             it is what lookups and joins compare. It cannot be reversed without the key.
--
-- Run `npm run encrypt-existing` after applying this if the tables already hold real or test numbers in the
-- clear; the app still reads old plain values meanwhile, but the report below cannot compare them until the
-- index is filled. (Starting from a reset database, there is nothing to convert.)

alter table consumables.links add column if not exists patient_hospital_no_idx text;
alter table consumables.investigation_imports add column if not exists patient_hospital_no_idx text;

-- The old indexes were on the number itself, which is now random text: useless. Index the fingerprint instead.
drop index if exists consumables.links_patient_idx;
drop index if exists consumables.investigation_imports_patient_idx;
create index links_patient_idx on consumables.links (patient_hospital_no_idx)
  where patient_hospital_no_idx is not null;
create index investigation_imports_patient_idx on consumables.investigation_imports (patient_hospital_no_idx);

-- v_orphan_issues compared the two numbers in SQL. It now compares their fingerprints. The columns are the
-- same as before; patient_hospital_no and imported_patient_hospital_no come out scrambled, and the report
-- service decrypts them. A link with no fingerprint yet (old data) is not reported as a mismatch.
create or replace view consumables.v_orphan_issues with (security_invoker = true) as
select
  l.id as link_id,
  l.reference_ref,
  l.test_code,
  l.patient_hospital_no,
  case when ii.id is null then 'NOT_IN_IMPORT' else 'MRN_MISMATCH' end as problem,
  ii.patient_hospital_no as imported_patient_hospital_no,
  coalesce(u.serial, b.code) as item_ref,
  it.name as item_name,
  loc.name as location_name,
  usr.name as issued_by_name,
  l.created_at as issued_at,
  l.cleared_at
from consumables.links l
left join consumables.investigation_imports ii on ii.investigation_ref = upper(l.reference_ref)
join consumables.batches b on b.id = l.batch_id
join consumables.item_types it on it.id = b.item_type_id
left join consumables.units u on u.id = l.unit_id
join consumables.locations loc on loc.id = l.location_id
join consumables.users usr on usr.id = l.issued_by
where l.reference_type = 'INVESTIGATION'
  and (
    ii.id is null
    or (
      l.patient_hospital_no_idx is not null
      and ii.patient_hospital_no_idx is distinct from l.patient_hospital_no_idx
    )
  );
