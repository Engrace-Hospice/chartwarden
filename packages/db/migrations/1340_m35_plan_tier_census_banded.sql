-- compat: expand
-- Slice 2 (tenant pricing) - the contracted census-banded plan model gets its own plan tier. Own file (the 1305 / 1320 precedent):
-- ALTER TYPE ... ADD VALUE is safe in the migration transaction only because nothing in this file uses the new value.
-- starter / professional / enterprise stay in the enum and on their rows: they are retired (1341), never removed.
ALTER TYPE "public"."plan_tier" ADD VALUE IF NOT EXISTS 'census_banded';
