-- compat: contract
-- L6D: preserve the exact server-owned evidence snapshot behind a nonposting review.
-- Older assessments remain readable as legacy observations; no historical row is backfilled as current.

ALTER TABLE medicaid_era_review
  ADD COLUMN assessment_evidence_fingerprint varchar(64),
  ADD COLUMN assessment_observed_at timestamptz;
--> statement-breakpoint
ALTER TABLE medicaid_era_review
  ADD CONSTRAINT medicaid_era_review_evidence_fingerprint_ck
  CHECK (
    (assessment_evidence_fingerprint IS NULL AND assessment_observed_at IS NULL)
    OR (assessment_evidence_fingerprint IS NOT NULL
        AND assessment_evidence_fingerprint ~ '^[0-9a-f]{64}$'
        AND assessment_observed_at IS NOT NULL)
  );
--> statement-breakpoint
CREATE FUNCTION guard_medicaid_era_review_observation_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.assessment_trust_status = 'isolated_evaluator'
     AND (NEW.assessment_evidence_fingerprint IS NULL OR NEW.assessment_observed_at IS NULL) THEN
    RAISE EXCEPTION 'trusted Medicaid ERA observation requires an evidence snapshot';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.assessment_evidence_fingerprint IS NOT NULL
       AND NEW.assessment_evidence_fingerprint IS NULL THEN
      RAISE EXCEPTION 'Medicaid ERA observation provenance cannot be removed';
    END IF;
    IF NEW.assessment_trust_status = 'isolated_evaluator'
       AND OLD.assessment_trust_status = 'legacy_unverified'
       AND (NEW.assessment_evidence_fingerprint IS NULL OR NEW.assessment_observed_at IS NULL) THEN
      RAISE EXCEPTION 'legacy Medicaid ERA promotion requires a new evidence snapshot';
    END IF;
    IF (NEW.assessment_evidence_fingerprint, NEW.assessment_observed_at)
         IS DISTINCT FROM (OLD.assessment_evidence_fingerprint, OLD.assessment_observed_at)
       AND NEW.version <= OLD.version THEN
      RAISE EXCEPTION 'Medicaid ERA evidence reassessment requires a version increment';
    END IF;
    IF NEW.assessment_trust_status IS DISTINCT FROM OLD.assessment_trust_status
       AND NEW.version <> OLD.version + 1 THEN
      RAISE EXCEPTION 'Medicaid ERA trust transition requires a version increment';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER medicaid_era_review_observation_snapshot
  BEFORE INSERT OR UPDATE ON medicaid_era_review
  FOR EACH ROW EXECUTE FUNCTION guard_medicaid_era_review_observation_snapshot();
