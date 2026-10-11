-- M23 — snapshot, at claim assembly, the attending / certifying physician NAMES and the DIAGNOSIS SEQUENCE the claim
-- carries, so a claim that has been sent does not change when the physician master data (M40) or the problem list (M7)
-- later does. Until now only the physician NPIs were stored (1054) and the diagnosis sequence was read at assembly and
-- not persisted at all.
--
--   claim.attending_physician_first_name / _last_name    M40 canonical name of the attending physician (UB-04 FL 76)
--   claim.certifying_physician_first_name / _last_name   same for the certifying physician (FL 78); NULL exactly when
--                                                        certifying_physician_npi is NULL (absent, or equal to the
--                                                        attending, the same rule as the NPI)
--   claim.diagnosis_snapshot  jsonb  ordered array of {icd10Code, sequence, qualifier 'ABK'|'ABF'}; '[]' = none / not
--                                    captured (claims assembled before this migration are not back-filled)
--
-- DESIGN: columns on `claim`, not a child table. The list is at most a dozen codes, always read and written as a unit
-- with the claim and never queried by code. `claim` is partitioned with PK (id, provider_entity_id) and no unique
-- index on id alone, so a child table could not carry a real FK to it; the columns instead inherit everything the claim
-- already has: FORCEd org RLS, the PHI write-audit trigger (the snapshot appears in the claim's audit rows), the
-- DRAFT-only delete guard of 1061 and the org erasure path. No new table, grant, manifest entry or eraser change.
-- No `presentOnAdmission`: M7 does not carry it, and inventing one would put a made-up indicator on a federal claim.
--
-- IMMUTABILITY (in the database, not the handler): the five snapshot columns may change only while the claim is, and
-- stays, DRAFT. A DRAFT -> VALIDATING hop that leaves them alone is unaffected; any other change fails with
-- M23_CLAIM_SNAPSHOT_IMMUTABLE. `claim` is LIST-partitioned: ADD COLUMN / CONSTRAINT / TRIGGER on the parent propagate.
-- Idempotent.
ALTER TABLE "claim" ADD COLUMN IF NOT EXISTS "attending_physician_first_name" text;--> statement-breakpoint
ALTER TABLE "claim" ADD COLUMN IF NOT EXISTS "attending_physician_last_name" text;--> statement-breakpoint
ALTER TABLE "claim" ADD COLUMN IF NOT EXISTS "certifying_physician_first_name" text;--> statement-breakpoint
ALTER TABLE "claim" ADD COLUMN IF NOT EXISTS "certifying_physician_last_name" text;--> statement-breakpoint
ALTER TABLE "claim" ADD COLUMN IF NOT EXISTS "diagnosis_snapshot" jsonb NOT NULL DEFAULT '[]'::jsonb;--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claim_attending_physician_name_chk') THEN
    ALTER TABLE "claim" ADD CONSTRAINT "claim_attending_physician_name_chk"
      CHECK (("attending_physician_first_name" IS NULL) = ("attending_physician_last_name" IS NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claim_certifying_physician_name_chk') THEN
    ALTER TABLE "claim" ADD CONSTRAINT "claim_certifying_physician_name_chk"
      CHECK (("certifying_physician_first_name" IS NULL) = ("certifying_physician_last_name" IS NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claim_diagnosis_snapshot_shape_chk') THEN
    ALTER TABLE "claim" ADD CONSTRAINT "claim_diagnosis_snapshot_shape_chk"
      CHECK (jsonb_typeof("diagnosis_snapshot") = 'array' AND jsonb_array_length("diagnosis_snapshot") <= 25);
  END IF;
END $$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION m23_claim_snapshot_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF (OLD.state <> 'DRAFT' OR NEW.state <> 'DRAFT')
     AND (NEW.attending_physician_first_name IS DISTINCT FROM OLD.attending_physician_first_name
       OR NEW.attending_physician_last_name IS DISTINCT FROM OLD.attending_physician_last_name
       OR NEW.certifying_physician_first_name IS DISTINCT FROM OLD.certifying_physician_first_name
       OR NEW.certifying_physician_last_name IS DISTINCT FROM OLD.certifying_physician_last_name
       OR NEW.diagnosis_snapshot IS DISTINCT FROM OLD.diagnosis_snapshot) THEN
    RAISE EXCEPTION 'M23_CLAIM_SNAPSHOT_IMMUTABLE: the physician / diagnosis snapshot of claim % can only change while it is a DRAFT (state %)', OLD.id, OLD.state
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_claim_snapshot_immutable" ON "claim";--> statement-breakpoint
CREATE TRIGGER "trg_claim_snapshot_immutable" BEFORE UPDATE ON "claim"
  FOR EACH ROW EXECUTE FUNCTION m23_claim_snapshot_immutable();
