-- claim_submission is an append-once attempt record, but the original schema inserted it as `queued`
-- on the request thread and then prohibited the worker from recording the terminal result. Permit exactly
-- one queued -> terminal transition while retaining every identity/subject/control field as immutable.
CREATE OR REPLACE FUNCTION m23_terminalize_claim_submission()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'claim_submission rows cannot be deleted'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.outcome <> 'queued'
     OR NEW.outcome NOT IN ('submitted', 'failed_worker', 'failed_portal')
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.provider_entity_id IS DISTINCT FROM OLD.provider_entity_id
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.claim_id IS DISTINCT FROM OLD.claim_id
     OR NEW.noe_id IS DISTINCT FROM OLD.noe_id
     OR NEW.notr_id IS DISTINCT FROM OLD.notr_id
     OR NEW.claim_control_number IS DISTINCT FROM OLD.claim_control_number
     OR NEW.attempt_index IS DISTINCT FROM OLD.attempt_index
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR (NEW.outcome = 'submitted' AND (
       NEW.generated_file_uri IS NULL
       OR NEW.submitted_at IS NULL
       OR NEW.worker_correlation_id IS NULL
       OR NEW.outcome_reason IS NOT NULL
     ))
     OR (NEW.outcome IN ('failed_worker', 'failed_portal') AND NEW.outcome_reason IS NULL)
  THEN
    RAISE EXCEPTION 'claim_submission is immutable except for one queued-to-terminal transition'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_append_only_claim_submission ON claim_submission;--> statement-breakpoint
CREATE TRIGGER trg_terminalize_claim_submission
BEFORE UPDATE OR DELETE ON claim_submission
FOR EACH ROW EXECUTE FUNCTION m23_terminalize_claim_submission();
