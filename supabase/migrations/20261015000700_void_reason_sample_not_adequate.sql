-- A returned bottle can now be voided as "Sample not adequate" (too little blood, clotted, wrong draw...).
-- The reasons are an admin-managed list; this adds one row and is safe to run twice.
insert into consumables.void_reasons (code, label)
values ('SAMPLE_NOT_ADEQUATE', 'Sample not adequate')
on conflict (code) do nothing;
