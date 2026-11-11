-- compat: contract
-- M41 correction lineage. A new original claim identity may overlap its rejected predecessor only within the same explicit chain.
ALTER TABLE "commercial_claim"
  ADD COLUMN "correction_of_claim_id" uuid,
  ADD COLUMN "correction_root_claim_id" uuid,
  ADD COLUMN "correction_kind" text,
  ADD COLUMN "correction_reason_code" text,
  ADD COLUMN "correction_request_key" text;
--> statement-breakpoint
ALTER TABLE "commercial_claim"
  ADD CONSTRAINT "commercial_claim_correction_parent_fk"
    FOREIGN KEY ("correction_of_claim_id", "organization_id")
    REFERENCES "commercial_claim" ("id", "organization_id") ON DELETE RESTRICT,
  ADD CONSTRAINT "commercial_claim_correction_root_fk"
    FOREIGN KEY ("correction_root_claim_id", "organization_id")
    REFERENCES "commercial_claim" ("id", "organization_id") ON DELETE RESTRICT,
  ADD CONSTRAINT "commercial_claim_correction_identity_check" CHECK (
    ("correction_of_claim_id" IS NULL AND "correction_root_claim_id" IS NULL AND "correction_kind" IS NULL AND "correction_reason_code" IS NULL AND "correction_request_key" IS NULL)
    OR
    ("correction_of_claim_id" IS NOT NULL AND "correction_root_claim_id" IS NOT NULL AND "correction_kind" = 'clearinghouse_rejection_resubmission'
      AND "correction_reason_code" IN ('claim_data_corrected','clearinghouse_edit_corrected','other_verified_correction')
      AND "correction_request_key" ~ '^[A-Za-z0-9._:-]{1,128}$')
  );
--> statement-breakpoint
CREATE INDEX "commercial_claim_correction_root_ix"
  ON "commercial_claim" ("organization_id", "correction_root_claim_id")
  WHERE "correction_root_claim_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "commercial_claim_correction_parent_key"
  ON "commercial_claim" ("organization_id", "correction_of_claim_id")
  WHERE "correction_of_claim_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "commercial_claim_correction_request_key"
  ON "commercial_claim" ("organization_id", "correction_request_key")
  WHERE "correction_request_key" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "commercial_claim" DROP CONSTRAINT "commercial_claim_no_overlap";
--> statement-breakpoint
DROP INDEX "commercial_claim_active_by_range_uq";
--> statement-breakpoint
CREATE FUNCTION m41_commercial_claim_lineage_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  v_parent "commercial_claim"%ROWTYPE;
  v_expected_root uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('m41:' || NEW.organization_id::text || ':' || NEW.patient_id::text, 0));

  IF NEW.correction_of_claim_id IS NOT NULL THEN
    SELECT * INTO v_parent FROM "commercial_claim"
      WHERE id = NEW.correction_of_claim_id AND organization_id = NEW.organization_id FOR UPDATE;
    IF NOT FOUND OR v_parent.state <> 'rejected' THEN
      RAISE EXCEPTION 'M41_CORRECTION_PARENT_NOT_REJECTED';
    END IF;
    v_expected_root := COALESCE(v_parent.correction_root_claim_id, v_parent.id);
    IF NEW.correction_root_claim_id IS DISTINCT FROM v_expected_root
      OR NEW.organization_id IS DISTINCT FROM v_parent.organization_id
      OR NEW.provider_entity_id IS DISTINCT FROM v_parent.provider_entity_id
      OR NEW.location_id IS DISTINCT FROM v_parent.location_id
      OR NEW.patient_id IS DISTINCT FROM v_parent.patient_id
      OR NEW.plan_id IS DISTINCT FROM v_parent.plan_id
      OR NEW.service_from IS DISTINCT FROM v_parent.service_from
      OR NEW.service_to IS DISTINCT FROM v_parent.service_to
      OR NEW.claim_filing_indicator IS DISTINCT FROM v_parent.claim_filing_indicator
      OR NEW.clearinghouse_key IS DISTINCT FROM v_parent.clearinghouse_key
      OR NEW.clearinghouse_payer_id IS DISTINCT FROM v_parent.clearinghouse_payer_id
      OR NEW.frequency_code IS DISTINCT FROM v_parent.frequency_code THEN
      RAISE EXCEPTION 'M41_CORRECTION_IDENTITY_MISMATCH';
    END IF;
  ELSIF NEW.correction_root_claim_id IS NOT NULL OR NEW.correction_kind IS NOT NULL
    OR NEW.correction_reason_code IS NOT NULL OR NEW.correction_request_key IS NOT NULL THEN
    RAISE EXCEPTION 'M41_CORRECTION_LINEAGE_INCOMPLETE';
  END IF;

  IF TG_OP = 'UPDATE' AND (
    NEW.correction_of_claim_id IS DISTINCT FROM OLD.correction_of_claim_id
    OR NEW.correction_root_claim_id IS DISTINCT FROM OLD.correction_root_claim_id
    OR NEW.correction_kind IS DISTINCT FROM OLD.correction_kind
    OR NEW.correction_reason_code IS DISTINCT FROM OLD.correction_reason_code
    OR NEW.correction_request_key IS DISTINCT FROM OLD.correction_request_key
  ) THEN
    RAISE EXCEPTION 'M41_CORRECTION_LINEAGE_IMMUTABLE';
  END IF;

  IF NEW.state <> 'void' AND EXISTS (
    SELECT 1 FROM "commercial_claim" other
    WHERE other.organization_id = NEW.organization_id
      AND other.patient_id = NEW.patient_id
      AND other.id <> NEW.id
      AND other.state <> 'void'
      AND daterange(other.service_from, other.service_to, '[]') && daterange(NEW.service_from, NEW.service_to, '[]')
      AND COALESCE(other.correction_root_claim_id, other.id) <> COALESCE(NEW.correction_root_claim_id, NEW.id)
  ) THEN
    RAISE EXCEPTION 'M41_CLAIM_WINDOW_OVERLAP';
  END IF;
  RETURN NEW;
END $fn$;
--> statement-breakpoint
CREATE TRIGGER "trg_m41_commercial_claim_lineage_guard"
  BEFORE INSERT OR UPDATE OF "organization_id", "provider_entity_id", "patient_id", "plan_id", "service_from", "service_to", "state", "correction_of_claim_id", "correction_root_claim_id", "correction_kind", "correction_reason_code", "correction_request_key"
  ON "commercial_claim" FOR EACH ROW EXECUTE FUNCTION m41_commercial_claim_lineage_guard();
--> statement-breakpoint
REVOKE ALL ON FUNCTION m41_commercial_claim_lineage_guard() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION m41_commercial_claim_lineage_guard() TO chartwarden_app;
