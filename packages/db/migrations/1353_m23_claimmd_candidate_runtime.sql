-- compat: contract
-- BIL-1.2.2B: narrowly grant the existing non-login Claim.MD integration role access to source evidence
-- required for deterministic account-scoped candidate resolution. No tenant grants or billing writes.
ALTER TABLE claimmd_response_resolution ADD COLUMN location_id uuid;--> statement-breakpoint
ALTER TABLE claimmd_response_resolution_history ADD COLUMN location_id uuid;--> statement-breakpoint
ALTER TABLE claimmd_response_resolution DROP CONSTRAINT claimmd_response_resolution_reason_code_check;--> statement-breakpoint
ALTER TABLE claimmd_response_resolution ADD CONSTRAINT claimmd_response_resolution_reason_code_check CHECK (
  reason_code IS NULL OR reason_code IN ('NO_MATCHING_SUBMISSION','MULTIPLE_CANDIDATES','PROVIDER_IDENTITY_MISMATCH',
  'TENANT_OWNERSHIP_CONFLICT','PAYER_MISMATCH','MISSING_STRONG_IDENTIFIERS','UNKNOWN_EXTERNAL_CLAIM',
  'HISTORICAL_IDENTITY_UNAVAILABLE','EXTERNAL_IDENTIFIER_CONFLICT','MALFORMED_SOURCE_EVENT',
  'RESOLUTION_TRANSIENT_FAILURE','CANDIDATE_LIMIT_EXCEEDED','RESOLUTION_RETRY_EXHAUSTED','OPERATOR_REQUEUED')
);--> statement-breakpoint

CREATE INDEX claimmd_receipt_candidate_lookup_ix
  ON claimmd_submission_receipt_observation(account_reference,usage,source_field,external_value,evidence_id);--> statement-breakpoint

GRANT SELECT ON claimmd_submission_evidence,claimmd_submission_receipt_observation TO claimmd_capture;--> statement-breakpoint
CREATE POLICY claimmd_evidence_internal_read ON claimmd_submission_evidence FOR SELECT TO claimmd_capture USING (true);--> statement-breakpoint
CREATE POLICY claimmd_receipt_internal_read ON claimmd_submission_receipt_observation FOR SELECT TO claimmd_capture USING (true);--> statement-breakpoint

GRANT SELECT (id,organization_id,provider_entity_id,claim_id,kind,claim_control_number,attempt_index)
  ON claim_submission TO claimmd_capture;--> statement-breakpoint
CREATE POLICY claimmd_claim_submission_internal_read ON claim_submission FOR SELECT TO claimmd_capture USING (true);--> statement-breakpoint
GRANT SELECT (id,organization_id,provider_entity_id,location_id,claim_id,control_number,clearinghouse_payer_id,clearinghouse_key)
  ON commercial_submission TO claimmd_capture;--> statement-breakpoint
CREATE POLICY claimmd_commercial_submission_internal_read ON commercial_submission FOR SELECT TO claimmd_capture USING (true);--> statement-breakpoint
GRANT SELECT (id,organization_id,provider_entity_id,usage,control_number,kind,status)
  ON clearinghouse_submission_attempt TO claimmd_capture;--> statement-breakpoint
CREATE POLICY claimmd_attempt_internal_read ON clearinghouse_submission_attempt FOR SELECT TO claimmd_capture USING (true);--> statement-breakpoint
GRANT SELECT (id,organization_id) ON provider_entity TO claimmd_capture;--> statement-breakpoint
CREATE POLICY claimmd_provider_internal_read ON provider_entity FOR SELECT TO claimmd_capture USING (true);--> statement-breakpoint
GRANT SELECT (id,provider_entity_id) ON location TO claimmd_capture;--> statement-breakpoint
CREATE POLICY claimmd_location_internal_read ON location FOR SELECT TO claimmd_capture USING (true);
