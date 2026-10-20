-- Seed: the hospital's "List of consumables and service points" (corrections.md, C1).
--
-- Idempotent: every insert uses `on conflict (code) do nothing`, so the script can be re-run and
-- never overwrites an edit made in the admin screens. Names are kept exactly as written in the
-- hospital's list (including "Pasture pipettes"; fix the spelling later if it is a typo).
--
-- Needs migration 20261011000100_consumables_list_fit.sql (service_role, allowed_service_roles,
-- pack_size, pack_size_confirmed) to be applied first.
--
-- Cold storage (corrections.md, C9; needs migration 20261011000600_cold_storage.sql): the anti-sera and AHG
-- are created flagged "Keep cold". Kits and strips are not, because the storage condition depends on the maker;
-- tick it on the Item types screen if the lab says so. Display only: it blocks nothing.
--
-- Pack sizes are placeholders: every item is created with pack_size_confirmed = false until the lab
-- confirms the real figure. Pack size only matters for QUANTITY items; for SERIAL items it stays 1.
-- allowed_service_roles = null means "may be sent anywhere".
--
-- Run: psql "$DATABASE_URL" -f scripts/seed-consumables.sql

begin;

-- ---------------------------------------------------------------------------
-- C1a. Item types (37)
-- ---------------------------------------------------------------------------
insert into consumables.item_types
  (code, name, category, tracking_mode, container_type, unit_of_measure, pack_size, pack_size_confirmed, allowed_service_roles, cold_storage, bench_supply)
select
  v.code,
  v.name,
  v.category,
  v.tracking_mode::consumables.tracking_mode,
  v.container_type,
  v.unit_of_measure,
  v.pack_size,
  false,
  v.allowed_service_roles,
  v.code in ('ANTI-A', 'ANTI-B', 'ANTI-D', 'AHG'),
  v.code in (
    'COTTON-WOOL-500G', 'STICKER-SAMPLE', 'MARKER-SAMPLE', 'TOURNIQUET', 'SPIRIT-METHYL-2L',
    'GLOVES-LATEX', 'MASK-FACE', 'BAG-ZIPLOCK', 'PIPETTE-PASTEUR', 'TIP-MICROPIPETTE', 'TUBE-ROHREN',
    'ANTI-A', 'ANTI-B', 'ANTI-D', 'AHG'
  )
from (
  values
    ('TUBE-EDTA-4ML',     'EDTA tube 4 mL',            'SAMPLE_CONTAINER', 'SERIAL',   'EDTA',     'Pieces', 1,   null::text[]),
    ('TUBE-PLAIN-5ML',    'Plain tube 5 mL',           'SAMPLE_CONTAINER', 'SERIAL',   'PLAIN',    'Pieces', 1,   null::text[]),
    ('TUBE-GEL-9ML',      'Gel tube 9ml',              'SAMPLE_CONTAINER', 'SERIAL',   'GEL',      'Pieces', 1,   null::text[]),
    ('TUBE-FLUORIDE-4ML', 'Fluoride tube, 4 mL',       'SAMPLE_CONTAINER', 'SERIAL',   'FLUORIDE', 'Pieces', 1,   null::text[]),
    ('TUBE-CITRATE-4ML',  'Citrate tube 4 mL',         'SAMPLE_CONTAINER', 'SERIAL',   'CITRATE',  'Pieces', 1,   null::text[]),
    ('TUBE-ESR',          'ESR tube',                  'SAMPLE_CONTAINER', 'SERIAL',   'ESR',      'Pieces', 1,   null::text[]),
    ('NEEDLE-VAC-21G',    'Vacutainer needles 21G',    'PHLEBOTOMY',       'QUANTITY', null,       'Pack',   100, null::text[]),
    ('NEEDLE-VAC-23G',    'Vacutainer needles 23G',    'PHLEBOTOMY',       'QUANTITY', null,       'Pack',   100, null::text[]),
    ('NEEDLE-BUTTERFLY',  'Butterfly needle',          'PHLEBOTOMY',       'QUANTITY', null,       'Pack',   100, null::text[]),
    ('SWAB-ALCOHOL',      'Alcohol swabs',             'PHLEBOTOMY',       'QUANTITY', null,       'Pack',   100, null::text[]),
    ('COTTON-WOOL-500G',  'Cotton wool 500g',          'PHLEBOTOMY',       'QUANTITY', null,       'Roll',   1,   null::text[]),
    ('TOURNIQUET',        'Tourniquets',               'PHLEBOTOMY',       'QUANTITY', null,       'Pieces', 1,   null::text[]),
    ('PLASTER-ADHESIVE',  'Adhesive plaster',          'PHLEBOTOMY',       'QUANTITY', null,       'Pack',   100, null::text[]),
    ('GLOVES-LATEX',      'Latex gloves',              'PPE',              'QUANTITY', null,       'Pack',   100, null::text[]),
    ('CONT-STOOL-30ML',   'Stool container, 30 mL',    'SAMPLE_CONTAINER', 'SERIAL',   'STOOL',    'Pieces', 1,   null::text[]),
    ('CONT-URINE-30ML',   'Urine container, 30mL',     'SAMPLE_CONTAINER', 'SERIAL',   'URINE',    'Pieces', 1,   null::text[]),
    ('CRYOVIAL-2ML',      'Cryovials, 2 mL',           'LAB_SUPPLY',       'QUANTITY', null,       'Pack',   100, null::text[]),
    ('SWAB-STICK',        'Swab sticks',               'LAB_SUPPLY',       'QUANTITY', null,       'Pack',   100, null::text[]),
    ('BAG-ZIPLOCK',       'Zip-lock bags',             'LAB_SUPPLY',       'QUANTITY', null,       'Pack',   100, null::text[]),
    ('SLIDE-FROSTED',     'Frosted microscope slides', 'LAB_SUPPLY',       'QUANTITY', null,       'Pack',   100, null::text[]),
    ('COVERSLIP',         'Cover slips',               'LAB_SUPPLY',       'QUANTITY', null,       'Pack',   100, null::text[]),
    ('SPIRIT-METHYL-2L',  'Methylated spirit, 2L',     'LAB_SUPPLY',       'QUANTITY', null,       'Pieces', 1,   null::text[]),
    ('TIP-MICROPIPETTE',  'Micropipette tips',         'LAB_SUPPLY',       'QUANTITY', null,       'Pack',   100, null::text[]),
    ('STICKER-SAMPLE',    'Sample sticker',            'LABELLING',        'QUANTITY', null,       'Roll',   1,   null::text[]),
    ('MARKER-SAMPLE',     'Sample marker',             'LABELLING',        'QUANTITY', null,       'Pieces', 1,   null::text[]),
    ('MASK-FACE',         'Face mask',                 'PPE',              'QUANTITY', null,       'Pack',   100, null::text[]),
    ('BAG-BLOOD',         'Blood bag',                 'BLOOD_BANK',       'SERIAL',   null,       'Pieces', 1,   array['BLOOD_BANK']),
    ('STRIP-HBV',         'HBV strip',                 'REAGENT',          'QUANTITY', null,       'Pack',   100, array['BENCH', 'BLOOD_BANK']),
    ('STRIP-HCV',         'HCV strip',                 'REAGENT',          'QUANTITY', null,       'Pack',   100, array['BENCH', 'BLOOD_BANK']),
    ('STRIP-VDRL',        'VDRL strip',                'REAGENT',          'QUANTITY', null,       'Pack',   100, array['BENCH', 'BLOOD_BANK']),
    ('KIT-HIV-DETERMINE', 'HIV Determine',             'REAGENT',          'QUANTITY', null,       'Pack',   100, array['BENCH', 'BLOOD_BANK']),
    ('TUBE-ROHREN',       'Rohren tubes',              'LAB_SUPPLY',       'QUANTITY', null,       'Pack',   100, null::text[]),
    ('PIPETTE-PASTEUR',   'Pasture pipettes',          'LAB_SUPPLY',       'QUANTITY', null,       'Pack',   100, null::text[]),
    ('ANTI-A',            'Anti-A',                    'REAGENT',          'QUANTITY', null,       'Pieces', 1,   array['BENCH', 'BLOOD_BANK']),
    ('ANTI-B',            'Anti-B',                    'REAGENT',          'QUANTITY', null,       'Pieces', 1,   array['BENCH', 'BLOOD_BANK']),
    ('ANTI-D',            'Anti-D',                    'REAGENT',          'QUANTITY', null,       'Pieces', 1,   array['BENCH', 'BLOOD_BANK']),
    ('AHG',               'AHG',                       'REAGENT',          'QUANTITY', null,       'Pieces', 1,   array['BENCH', 'BLOOD_BANK'])
) as v(code, name, category, tracking_mode, container_type, unit_of_measure, pack_size, allowed_service_roles)
on conflict (code) do nothing;

-- ---------------------------------------------------------------------------
-- C1b. Locations (21). The main store already exists and is not re-created.
-- ---------------------------------------------------------------------------
insert into consumables.locations (code, name, type, service_role)
select v.code, v.name, v.type::consumables.location_type, v.service_role
from (
  values
    ('MAIN-LAB-RECEPTION', 'Main lab reception', 'STORE', 'STORE'),
    ('BLOOD-BANK',         'Blood bank',         'LAB',   'BLOOD_BANK'),
    ('GOPD',               'GOPD',               'OTHER', 'COLLECTION_POINT'),
    ('FAST-TRACK',         'Fast-track',         'OTHER', 'COLLECTION_POINT'),
    ('AMENITY',            'Amenity',            'OTHER', 'COLLECTION_POINT'),
    ('EPU',                'EPU',                'OTHER', 'COLLECTION_POINT'),
    ('SCBU',               'SCBU',               'WARD',  'COLLECTION_POINT'),
    ('NEW-AE',             'NEW A&E',            'OTHER', 'COLLECTION_POINT'),
    ('LNG',                'LNG',                'OTHER', 'COLLECTION_POINT'),
    ('DIALYSIS',           'DIALYSIS',           'OTHER', 'COLLECTION_POINT'),
    ('OLD-AE',             'OLD A&E',            'OTHER', 'COLLECTION_POINT'),
    ('MMW',                'MMW',                'WARD',  'COLLECTION_POINT'),
    ('FMW',                'FMW',                'WARD',  'COLLECTION_POINT'),
    ('MSW',                'MSW',                'WARD',  'COLLECTION_POINT'),
    ('FSW',                'FSW',                'WARD',  'COLLECTION_POINT'),
    ('GYNAE',              'GYNAE',              'WARD',  'COLLECTION_POINT'),
    ('PNW',                'PNW',                'WARD',  'COLLECTION_POINT'),
    ('CHEM-PATH',          'Chem Path',          'LAB',   'BENCH'),
    ('MICROBIOLOGY',       'Microbiology',       'LAB',   'BENCH'),
    ('HAEMATOLOGY',        'Haematology',        'LAB',   'BENCH'),
    ('HISTO-PATH',         'Histo Path',         'LAB',   'BENCH')
) as v(code, name, type, service_role)
on conflict (code) do nothing;

commit;
