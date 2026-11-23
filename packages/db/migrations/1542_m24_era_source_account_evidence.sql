-- compat: contract
-- L6B: add non-secret account identity to M24's existing ERA enrollment evidence.
-- Historical records remain NULL/unqualified; no account or environment is inferred.
ALTER TABLE medicaid_enrollment_evidence
  ADD COLUMN vendor_account_ref varchar(128),
  ADD COLUMN source_environment varchar(16),
  ADD COLUMN evidence_fresh_until date;
--> statement-breakpoint
ALTER TABLE medicaid_enrollment_evidence
  ADD CONSTRAINT medicaid_enrollment_source_environment_ck
    CHECK (source_environment IS NULL OR source_environment IN ('test', 'production')) NOT VALID,
  ADD CONSTRAINT medicaid_enrollment_vendor_account_ref_ck
    CHECK (vendor_account_ref IS NULL OR vendor_account_ref ~ '^[A-Za-z0-9._:-]{1,128}$') NOT VALID,
  ADD CONSTRAINT medicaid_enrollment_835_source_identity_ck
    CHECK (evidence_kind <> '835_era_enrollment' OR status <> 'verified' OR
      (clearinghouse IN ('claimmd', 'stedi') AND vendor_account_ref IS NOT NULL AND
       source_environment IN ('test', 'production') AND canonical_payer_id IS NOT NULL AND
       vendor_payer_id IS NOT NULL AND program_kind IS NOT NULL AND transaction_type = '835' AND
       effective_to IS NOT NULL AND evidence_fresh_until IS NOT NULL)) NOT VALID,
  ADD CONSTRAINT medicaid_enrollment_evidence_freshness_ck
    CHECK (evidence_fresh_until IS NULL OR effective_from <= evidence_fresh_until) NOT VALID;
--> statement-breakpoint
CREATE INDEX medicaid_enrollment_era_account_lookup_ix
  ON medicaid_enrollment_evidence
    (organization_id, provider_entity_id, clearinghouse, vendor_account_ref, source_environment,
     canonical_payer_id, effective_from, effective_to)
  WHERE evidence_kind = '835_era_enrollment' AND status = 'verified';
