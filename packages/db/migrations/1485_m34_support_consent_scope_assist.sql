-- compat: expand
-- Slice 7 (7S) - the non-PHI consent scope an onboarding help request creates. Own file (the 1305 / 1320 / 1410 precedent):
-- ALTER TYPE ... ADD VALUE is safe in the migration transaction only because nothing in this file uses the new value.
ALTER TYPE "public"."support_consent_grant_scope" ADD VALUE IF NOT EXISTS 'assist';
