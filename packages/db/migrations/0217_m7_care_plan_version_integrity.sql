-- M7 Phase 1 — one open version per care plan and DB-backed version snapshot integrity.
--
-- Existing signed versions with NULL state_snapshot are legacy pre-integrity records and are left untouched.

CREATE UNIQUE INDEX IF NOT EXISTS care_plan_version_one_open_per_plan_uq
  ON care_plan_version (care_plan_id)
  WHERE status IN ('draft', 'in_review');

CREATE OR REPLACE FUNCTION enforce_care_plan_version_snapshot_integrity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'in_review' AND NEW.status = 'in_review'
     AND NEW.state_snapshot IS DISTINCT FROM OLD.state_snapshot THEN
    RAISE EXCEPTION 'care_plan_version.state_snapshot is frozen while in_review'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.status IN ('signed', 'superseded') THEN
    IF NEW.state_snapshot IS DISTINCT FROM OLD.state_snapshot THEN
      RAISE EXCEPTION 'care_plan_version.state_snapshot is immutable after signature'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.required_signer_set IS DISTINCT FROM OLD.required_signer_set THEN
      RAISE EXCEPTION 'care_plan_version.required_signer_set is immutable after signature'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.signed_at IS DISTINCT FROM OLD.signed_at THEN
      RAISE EXCEPTION 'care_plan_version.signed_at is immutable after signature'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_care_plan_version_snapshot_integrity ON care_plan_version;
CREATE TRIGGER trg_care_plan_version_snapshot_integrity
BEFORE UPDATE ON care_plan_version
FOR EACH ROW
EXECUTE FUNCTION enforce_care_plan_version_snapshot_integrity();
