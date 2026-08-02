-- M6L-T04 — the §4.2.7 discharge reason `other` had no `discharge_type` enum member, so a service-level
-- discharge with reason `other` could not be persisted. Add it in its OWN migration: a new enum value
-- must be committed before it is USED (PG forbids using a value added earlier in the same transaction),
-- so this ADD VALUE stands alone ahead of migration 0126 which relies on the enum being complete.
ALTER TYPE "public"."discharge_type" ADD VALUE IF NOT EXISTS 'other';
