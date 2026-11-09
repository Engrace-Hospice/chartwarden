-- compat: contract
-- BIL-2.1.2: bind reviewed M23 837I business input to its original append-only submission attempt.
ALTER TYPE claim_submission_outcome ADD VALUE IF NOT EXISTS 'held_stale_source';
--> statement-breakpoint
ALTER TABLE claim_submission ADD COLUMN reviewed_source_fingerprint text;
--> statement-breakpoint
ALTER TABLE claim_submission ADD CONSTRAINT claim_submission_reviewed_source_fingerprint_ck
  CHECK (reviewed_source_fingerprint IS NULL OR reviewed_source_fingerprint ~ '^[0-9a-f]{64}$');
--> statement-breakpoint
CREATE OR REPLACE FUNCTION m23_terminalize_claim_submission()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'claim_submission rows cannot be deleted' USING ERRCODE = '55000';
  END IF;
  IF OLD.outcome <> 'queued'
     OR NEW.outcome NOT IN ('submitted', 'failed_worker', 'failed_portal', 'held_stale_source')
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.provider_entity_id IS DISTINCT FROM OLD.provider_entity_id
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.claim_id IS DISTINCT FROM OLD.claim_id
     OR NEW.noe_id IS DISTINCT FROM OLD.noe_id
     OR NEW.notr_id IS DISTINCT FROM OLD.notr_id
     OR NEW.claim_control_number IS DISTINCT FROM OLD.claim_control_number
     OR NEW.attempt_index IS DISTINCT FROM OLD.attempt_index
     OR NEW.reviewed_source_fingerprint IS DISTINCT FROM OLD.reviewed_source_fingerprint
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR (NEW.outcome = 'submitted' AND (NEW.generated_file_uri IS NULL OR NEW.submitted_at IS NULL OR NEW.worker_correlation_id IS NULL OR NEW.outcome_reason IS NOT NULL))
     OR (NEW.outcome IN ('failed_worker', 'failed_portal') AND NEW.outcome_reason IS NULL)
     OR (NEW.outcome = 'held_stale_source' AND (NEW.outcome_reason IS DISTINCT FROM 'CLAIM_PREVIEW_STALE' OR NEW.generated_file_uri IS NOT NULL OR NEW.submitted_at IS NOT NULL))
  THEN
    RAISE EXCEPTION 'claim_submission is immutable except for one queued-to-terminal transition' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
