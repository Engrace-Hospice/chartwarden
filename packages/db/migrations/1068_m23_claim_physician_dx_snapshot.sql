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
-- already has: FORCEd org RLS, the PHI write-audit trigger, the DRAFT-only delete guard of 1061 and the org erasure
-- path. No new table, grant or manifest entry.
-- No `presentOnAdmission`: M7 does not carry it, and inventing one would put a made-up indicator on a federal claim.
--
-- PHI: `diagnosis_snapshot` is a patient's ICD-10 codes (claim.patient_id links them), so it is PHI. Two consequences:
--   * AUDIT: `audit_phi_write_claim` (0079, scrubbed in 1062) copies the claim row into `audit_event.before/after`. It is
--     redefined below so `diagnosis_snapshot` and the four physician-name columns are written as "<changed>" (the event
--     still shows THAT they changed, never the codes or names). Everything else about the function is as in 1062.
--   * ERASURE: no eraser change is needed. The M23 `billing_record` eraser (erasers/billing-eraser.ts) hard-DELETEs a
--     patient's claim rows in-cascade (claim.patient_id), so the snapshot columns go with the row; it does not UPDATE
--     claim columns other than the `replacement_reason` shred, so nothing here needs redacting first.
--
-- MUTABILITY (in the database, not the handler): the snapshot FOLLOWS THE PHYSICIAN NPIs until the claim is submitted.
-- Revalidation re-resolves the NPIs from M40 (refreshSnapshot), and the names and diagnosis sequence are rewritten in the
-- same statement so the NPI and the name beside it can never describe different physicians. The five snapshot columns
-- may therefore change only while the claim is, and stays, in DRAFT, VALIDATING or READY. From SUBMITTED onward (and
-- on any hop into such a state) they are frozen; a change fails with M23_CLAIM_SNAPSHOT_IMMUTABLE. A transition that
-- leaves them alone (DRAFT -> VALIDATING -> READY -> SUBMITTED) is unaffected. `claim` is LIST-partitioned: ADD COLUMN /
-- CONSTRAINT / TRIGGER on the parent propagate. Idempotent.
ALTER TABLE "claim" ADD COLUMN IF NOT EXISTS "attending_physician_first_name" text;--> statement-breakpoint
ALTER TABLE "claim" ADD COLUMN IF NOT EXISTS "attending_physician_last_name" text;--> statement-breakpoint
ALTER TABLE "claim" ADD COLUMN IF NOT EXISTS "certifying_physician_first_name" text;--> statement-breakpoint
ALTER TABLE "claim" ADD COLUMN IF NOT EXISTS "certifying_physician_last_name" text;--> statement-breakpoint
ALTER TABLE "claim" ADD COLUMN IF NOT EXISTS "diagnosis_snapshot" jsonb NOT NULL DEFAULT '[]'::jsonb;--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'claim'::regclass AND conname = 'claim_attending_physician_name_chk') THEN
    ALTER TABLE "claim" ADD CONSTRAINT "claim_attending_physician_name_chk"
      CHECK (("attending_physician_first_name" IS NULL) = ("attending_physician_last_name" IS NULL)) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'claim'::regclass AND conname = 'claim_certifying_physician_name_chk') THEN
    ALTER TABLE "claim" ADD CONSTRAINT "claim_certifying_physician_name_chk"
      CHECK (("certifying_physician_first_name" IS NULL) = ("certifying_physician_last_name" IS NULL)) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'claim'::regclass AND conname = 'claim_physician_name_len_chk') THEN
    ALTER TABLE "claim" ADD CONSTRAINT "claim_physician_name_len_chk"
      CHECK (char_length("attending_physician_first_name") <= 100
         AND char_length("attending_physician_last_name") <= 100
         AND char_length("certifying_physician_first_name") <= 100
         AND char_length("certifying_physician_last_name") <= 100) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'claim'::regclass AND conname = 'claim_diagnosis_snapshot_shape_chk') THEN
    ALTER TABLE "claim" ADD CONSTRAINT "claim_diagnosis_snapshot_shape_chk"
      CHECK (jsonb_typeof("diagnosis_snapshot") = 'array' AND jsonb_array_length("diagnosis_snapshot") <= 25) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "claim" VALIDATE CONSTRAINT "claim_attending_physician_name_chk";--> statement-breakpoint
ALTER TABLE "claim" VALIDATE CONSTRAINT "claim_certifying_physician_name_chk";--> statement-breakpoint
ALTER TABLE "claim" VALIDATE CONSTRAINT "claim_physician_name_len_chk";--> statement-breakpoint
ALTER TABLE "claim" VALIDATE CONSTRAINT "claim_diagnosis_snapshot_shape_chk";--> statement-breakpoint

CREATE OR REPLACE FUNCTION m23_claim_snapshot_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT (OLD.state IN ('DRAFT', 'VALIDATING', 'READY') AND NEW.state IN ('DRAFT', 'VALIDATING', 'READY'))
     AND (NEW.attending_physician_first_name IS DISTINCT FROM OLD.attending_physician_first_name
       OR NEW.attending_physician_last_name IS DISTINCT FROM OLD.attending_physician_last_name
       OR NEW.certifying_physician_first_name IS DISTINCT FROM OLD.certifying_physician_first_name
       OR NEW.certifying_physician_last_name IS DISTINCT FROM OLD.certifying_physician_last_name
       OR NEW.diagnosis_snapshot IS DISTINCT FROM OLD.diagnosis_snapshot) THEN
    RAISE EXCEPTION 'M23_CLAIM_SNAPSHOT_IMMUTABLE: the physician / diagnosis snapshot of claim % can only change while it is DRAFT, VALIDATING or READY (state %)', OLD.id, OLD.state
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_claim_snapshot_immutable" ON "claim";--> statement-breakpoint
CREATE TRIGGER "trg_claim_snapshot_immutable" BEFORE UPDATE ON "claim"
  FOR EACH ROW EXECUTE FUNCTION m23_claim_snapshot_immutable();
--> statement-breakpoint

-- Keep the patient's diagnosis codes (and the physician names) out of the compliance audit stream: the 1062 definition
-- with the five snapshot columns added to the scrub list. Nothing else changes (SECURITY DEFINER, owner, search_path).
CREATE OR REPLACE FUNCTION audit_phi_write_claim() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_before jsonb; v_after jsonb;
  v_cols text[] := ARRAY['replacement_reason', 'diagnosis_snapshot', 'attending_physician_first_name', 'attending_physician_last_name', 'certifying_physician_first_name', 'certifying_physician_last_name']::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN public.audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN public.audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO public.audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'claim.' || lower(TG_OP), 'claim', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), '')), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_claim() OWNER TO wardenx_audit_writer;
