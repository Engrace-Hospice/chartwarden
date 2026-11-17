-- compat: contract
-- M23-CM5-T1.3: allow explicit fail-closed hold reasons and make missing tenant scope deny cleanly.
CREATE OR REPLACE FUNCTION m23_terminalize_claim_submission()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'claim_submission rows cannot be deleted' USING ERRCODE = '55000';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.provider_entity_id IS DISTINCT FROM OLD.provider_entity_id
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.claim_id IS DISTINCT FROM OLD.claim_id
     OR NEW.noe_id IS DISTINCT FROM OLD.noe_id
     OR NEW.notr_id IS DISTINCT FROM OLD.notr_id
     OR NEW.transfer_notice_id IS DISTINCT FROM OLD.transfer_notice_id
     OR NEW.claim_control_number IS DISTINCT FROM OLD.claim_control_number
     OR NEW.attempt_index IS DISTINCT FROM OLD.attempt_index
     OR NEW.reviewed_source_fingerprint IS DISTINCT FROM OLD.reviewed_source_fingerprint
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'claim_submission identity is immutable' USING ERRCODE = '55000';
  END IF;

  IF NEW.outcome = 'queued' THEN
    IF OLD.outcome <> 'queued'
       OR NOT (
         (OLD.dispatch_state = 'pending' AND NEW.dispatch_state = 'sending'
           AND NEW.dispatch_token IS NOT NULL AND NEW.dispatch_started_at IS NOT NULL
           AND NEW.dispatch_reason_code IS NULL)
         OR
         (OLD.dispatch_state = 'sending' AND NEW.dispatch_state = 'in_doubt'
           AND NEW.dispatch_token IS NOT DISTINCT FROM OLD.dispatch_token
           AND NEW.dispatch_started_at IS NOT DISTINCT FROM OLD.dispatch_started_at
           AND NEW.dispatch_reason_code IS NOT NULL)
       )
       OR NEW.outcome_reason IS DISTINCT FROM OLD.outcome_reason
       OR NEW.generated_file_uri IS DISTINCT FROM OLD.generated_file_uri
       OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at
       OR NEW.worker_correlation_id IS DISTINCT FROM OLD.worker_correlation_id
    THEN
      RAISE EXCEPTION 'claim_submission dispatch state transition is invalid' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.outcome <> 'queued'
     OR OLD.dispatch_state NOT IN ('pending', 'sending', 'in_doubt')
     OR NEW.dispatch_state <> 'finished'
     OR (OLD.dispatch_state IN ('sending', 'in_doubt') AND NEW.dispatch_token IS DISTINCT FROM OLD.dispatch_token)
     OR (OLD.dispatch_state = 'pending' AND (NEW.dispatch_token IS NOT NULL OR NEW.dispatch_started_at IS NOT NULL))
     OR (OLD.dispatch_state = 'in_doubt' AND NEW.outcome <> 'submitted')
     OR (OLD.dispatch_state = 'sending' AND NEW.outcome NOT IN ('submitted', 'failed_portal'))
     OR NEW.dispatch_started_at IS DISTINCT FROM OLD.dispatch_started_at
     OR NEW.dispatch_reason_code IS DISTINCT FROM OLD.dispatch_reason_code
     OR NEW.outcome NOT IN ('submitted', 'failed_worker', 'failed_portal', 'held_stale_source')
     OR (NEW.outcome = 'submitted' AND ((OLD.kind = 'claim_837i' AND OLD.dispatch_state NOT IN ('sending', 'in_doubt')) OR NEW.generated_file_uri IS NULL OR NEW.submitted_at IS NULL OR NEW.worker_correlation_id IS NULL OR NEW.outcome_reason IS NOT NULL))
     OR (NEW.outcome IN ('failed_worker', 'failed_portal') AND NEW.outcome_reason IS NULL)
     OR (NEW.outcome = 'held_stale_source' AND (
          NEW.outcome_reason IS NULL OR NEW.outcome_reason NOT IN ('CLAIM_PREVIEW_STALE', 'EXTERNAL_PCN_REQUIRES_REVIEW',
            'CLEARINGHOUSE_ROUTE_CHANGED', 'CLEARINGHOUSE_BINDING_CHANGED')
          OR NEW.generated_file_uri IS NOT NULL OR NEW.submitted_at IS NOT NULL))
  THEN
    RAISE EXCEPTION 'claim_submission is immutable except for an authorized dispatch lifecycle transition' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
ALTER POLICY "claim_submission_org" ON claim_submission
  USING (organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid);
