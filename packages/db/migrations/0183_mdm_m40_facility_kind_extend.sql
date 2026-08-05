-- M40 MDM `facility_kind` — WX-PR-011 place-of-service follow-up. The original 6-value enum (hospital,
-- alf, snf, ipu, clinic, other) cannot represent the full 9-value CMS hospice Q5001-Q5009
-- place-of-service space: `snf` conflates skilled and non-skilled nursing facilities (Q5004 vs Q5003),
-- and there was no long-term-care-hospital or inpatient-psychiatric value (Q5007/Q5008). Additive only
-- (no removal, no existing row affected). Own migration: PG forbids using a value added earlier in the
-- same transaction, so this stands alone ahead of any migration that reads/writes it (the 0125
-- discharge_type precedent).
ALTER TYPE "public"."facility_kind" ADD VALUE IF NOT EXISTS 'nf';--> statement-breakpoint
ALTER TYPE "public"."facility_kind" ADD VALUE IF NOT EXISTS 'ltch';--> statement-breakpoint
ALTER TYPE "public"."facility_kind" ADD VALUE IF NOT EXISTS 'psych';
