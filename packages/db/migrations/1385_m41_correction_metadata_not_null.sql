-- compat: contract
-- BIL-2.5: PostgreSQL CHECK treats NULL as satisfied; explicitly require correction metadata on linked claims.
ALTER TABLE "commercial_claim"
  ADD CONSTRAINT "commercial_claim_correction_metadata_complete_ck" CHECK (
    (
      "correction_of_claim_id" IS NULL
      AND "correction_root_claim_id" IS NULL
      AND "correction_kind" IS NULL
      AND "correction_reason_code" IS NULL
      AND "correction_request_key" IS NULL
    )
    OR
    (
      "correction_of_claim_id" IS NOT NULL
      AND "correction_root_claim_id" IS NOT NULL
      AND "correction_kind" IS NOT NULL
      AND "correction_kind" = 'clearinghouse_rejection_resubmission'
      AND "correction_reason_code" IS NOT NULL
      AND "correction_reason_code" IN (
        'claim_data_corrected', 'clearinghouse_edit_corrected', 'other_verified_correction'
      )
      AND "correction_request_key" IS NOT NULL
      AND "correction_request_key" ~ '^[A-Za-z0-9._:-]{1,128}$'
    )
  );
