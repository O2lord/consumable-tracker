-- Test catalog: codes, portal names and required containers.
-- Run in the Supabase SQL editor (or psql). Safe to run more than once:
--   * a new code is added with its name and container;
--   * a code that already exists keeps its name and only gets its container corrected.
-- A NULL container means "any container will do" (swabs, urine and stool pots, slides).
--
-- Names are the portal's own wording. The panel matches a portal test to this list by code, then by a
-- bracketed code at the end of the name, then by name with case and punctuation ignored.

insert into consumables.test_catalog (code, name, required_container_type) values
  -- Histopathology & Cytology
  ('IHC',    'Immunohistochemistry (IHC)',                  'FORMALIN'),
  ('BMB',    'Bone Marrow Biopsy',                          'FORMALIN'),
  ('FNAC',   'Fine Needle Aspiration Cytology (FNAC)',      null),
  ('TBH',    'Tissue Biopsy Histology',                     'FORMALIN'),
  ('PAP',    'Pap Smear',                                   null),
  -- Serology & Immunology
  ('VDRL',   'VDRL/Syphilis Test',                          'PLAIN'),
  ('RVS',    'Retroviral Screening (ELISA)',                'PLAIN'),
  ('HIV-RDT','HIV Screening(Rapid Test)',                   'PLAIN'),
  ('HBSAG',  'Hepatitis B Surface Antigen (HBsAg)',         'PLAIN'),
  ('WIDAL',  'Widal Test',                                  'PLAIN'),
  -- Microbiology
  ('HVS',    'High Vaginal Swab(HVS) Culture',              null),
  ('AFB',    'Sputum AFB/Culture',                          null),
  ('BCS',    'Blood Culture & Sensitivity',                 'PLAIN'),
  ('SMC',    'Stool Microscopy & Culture',                  null),
  ('UMCS',   'Urine Microscopy, Culture & Sensitivity',     null),
  -- Biochemistry
  ('HBA1C',  'HBA1c (Glycated Haemoglobin)',                'EDTA'),
  ('LIPID',  'Lipid Profile',                               'PLAIN'),
  ('RFT',    'Renal Function Test (RFT/U&E)',               'PLAIN'),
  ('LFT',    'Liver Function Test (LFT)',                   'PLAIN'),   -- was EDTA
  ('FBS',    'Fasting Blood Sugar(FBS)',                    'FLUORIDE'), -- was CITRATE
  -- Blood bank (already in the catalog)
  ('GXM',    'Blood Group & Genotype',                      'EDTA')      -- was PLAIN; confirm with your lab
on conflict (code) do update
  set required_container_type = excluded.required_container_type,
      updated_at = now();

-- Alternate containers (corrections.md, C4; needs migration 20261011000300_container_alternates.sql).
-- The hospital stocks both plain and gel tubes, and many chemistry tests can use either. A test lists the
-- other containers it also accepts in alternate_container_types; the issue check and the panel's "also use
-- this bottle" list then treat either tube as correct.
--
-- BEST GUESS, NOT CONFIRMED: the lab has not yet said which tests take either tube. Serum tests that name a
-- plain tube are assumed to accept a gel tube too. Every test stays flagged "unconfirmed" on the admin Test
-- catalog screen (needs migration 20261011000500_container_confirmed.sql) until the lab confirms it; then tick
-- "Container and alternates confirmed with the lab" there, correcting "Also accepts" if the lab says otherwise.
--
-- Safe to re-run: this only fills in a test that is still unconfirmed and has no alternates, so anything the lab
-- confirmed, or someone set by hand and ticked as confirmed, is left alone. A wrong guess is permissive (a gel
-- tube is accepted where the lab might want a plain one), which is why it is flagged and why it is easy to undo:
-- clear "Also accepts" on the screen and tick Confirmed.
update consumables.test_catalog
  set alternate_container_types = array['GEL'],
      updated_at = now()
  where code in ('VDRL', 'RVS', 'HIV-RDT', 'HBSAG', 'WIDAL', 'LIPID', 'RFT', 'LFT')
    and required_container_type = 'PLAIN'
    and containers_confirmed = false
    and cardinality(alternate_container_types) = 0;
