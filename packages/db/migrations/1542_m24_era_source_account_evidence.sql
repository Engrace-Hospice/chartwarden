-- compat: contract
-- L6B: add non-secret account identity to M24's existing ERA enrollment evidence.
-- Historical records remain NULL/unqualified; no account or environment is inferred.
ALTER TABLE medicaid_enrollment_evidence
  ADD COLUMN vendor_account_ref varchar(128),
  ADD COLUMN source_environment varchar(16),
  ADD COLUMN evidence_fresh_until date;
--> statement-breakpoint
-- Validated at once (no NOT VALID): the table is born in 1535 and carries no row that could violate these.
ALTER TABLE medicaid_enrollment_evidence
  ADD CONSTRAINT medicaid_enrollment_source_environment_ck
    CHECK (source_environment IS NULL OR source_environment IN ('test', 'production')),
  ADD CONSTRAINT medicaid_enrollment_vendor_account_ref_ck
    CHECK (vendor_account_ref IS NULL OR vendor_account_ref ~ '^[A-Za-z0-9._:-]{1,128}$'),
  ADD CONSTRAINT medicaid_enrollment_835_source_identity_ck
    CHECK (evidence_kind <> '835_era_enrollment' OR status <> 'verified' OR
      (clearinghouse IN ('claimmd', 'stedi') AND vendor_account_ref IS NOT NULL AND
       source_environment IN ('test', 'production') AND canonical_payer_id IS NOT NULL AND
       vendor_payer_id IS NOT NULL AND program_kind IS NOT NULL AND transaction_type = '835' AND
       effective_to IS NOT NULL AND evidence_fresh_until IS NOT NULL)),
  ADD CONSTRAINT medicaid_enrollment_evidence_freshness_ck
    CHECK (evidence_fresh_until IS NULL OR effective_from <= evidence_fresh_until);
--> statement-breakpoint
-- The three new columns are part of the row's identity too: 1535's guard froze identity for every role, so a verified
-- test-account enrollment could not become a production one by UPDATE; without the new columns in the frozen set the
-- table owner or an admin role could do exactly that. Redefined here with the same body plus the three columns.
CREATE OR REPLACE FUNCTION guard_medicaid_enrollment_evidence_update() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF ROW(NEW.id, NEW.organization_id, NEW.provider_entity_id, NEW.service_state, NEW.program_kind, NEW.canonical_payer_id,
         NEW.clearinghouse, NEW.vendor_payer_id, NEW.transaction_type, NEW.evidence_kind, NEW.effective_from,
         NEW.effective_to, NEW.recorded_by_membership_id, NEW.supersedes_id, NEW.created_at,
         NEW.vendor_account_ref, NEW.source_environment, NEW.evidence_fresh_until)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.organization_id, OLD.provider_entity_id, OLD.service_state, OLD.program_kind, OLD.canonical_payer_id,
         OLD.clearinghouse, OLD.vendor_payer_id, OLD.transaction_type, OLD.evidence_kind, OLD.effective_from,
         OLD.effective_to, OLD.recorded_by_membership_id, OLD.supersedes_id, OLD.created_at,
         OLD.vendor_account_ref, OLD.source_environment, OLD.evidence_fresh_until) THEN
    RAISE EXCEPTION 'medicaid_enrollment_evidence: the identity of an evidence row cannot be changed' USING ERRCODE = '23514';
  END IF;
  IF OLD.status IN ('rejected', 'expired', 'revoked', 'superseded') THEN
    RAISE EXCEPTION 'medicaid_enrollment_evidence: a rejected, expired, revoked or superseded evidence row is final' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'verified' AND NEW.status NOT IN ('verified', 'revoked', 'expired', 'superseded') THEN
    RAISE EXCEPTION 'medicaid_enrollment_evidence: a verified evidence row can only be revoked, expired or superseded' USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'pending'
     AND ROW(NEW.verification_source, NEW.evidence_reference, NEW.verified_at, NEW.verified_by_membership_id)
         IS DISTINCT FROM
         ROW(OLD.verification_source, OLD.evidence_reference, OLD.verified_at, OLD.verified_by_membership_id) THEN
    RAISE EXCEPTION 'medicaid_enrollment_evidence: verification evidence cannot change once the row has left pending' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE INDEX medicaid_enrollment_era_account_lookup_ix
  ON medicaid_enrollment_evidence
    (organization_id, provider_entity_id, clearinghouse, vendor_account_ref, source_environment,
     canonical_payer_id, effective_from, effective_to)
  WHERE evidence_kind = '835_era_enrollment' AND status = 'verified';
