-- M7 (GAP-011) — one membership fills at most ONE live signer slot per care-plan version.
--
-- The only uniqueness on care_plan_signature was (care_plan_version_id, signer_role) WHERE invalidated_at IS
-- NULL, so a single person who could claim every role (the role was a client-supplied body field) filled the
-- whole quorum alone. The service now refuses a role the actor does not hold and a second signature by the
-- same membership; this BEFORE INSERT trigger is the DB backstop, mirroring M15's migration 0329.
--
-- A trigger rather than a unique index: signatures are immutable attestations, and a unique index would
-- hard-fail the auto-deploy if legacy rows already hold one person in two slots. The trigger refuses only
-- NEW duplicates and never rewrites history. It raises 23505 naming the constraint the app maps to
-- 409 SIGNER_ALREADY_SIGNED. A transaction-scoped advisory lock on the key serialises concurrent signs.
-- Invalidated (returned-to-draft) signatures do not count, so the same person may re-sign after a return.
-- membership_id is nullable (system/legacy rows); a NULL membership is never constrained.

CREATE OR REPLACE FUNCTION enforce_care_plan_signature_one_slot_per_membership()
RETURNS trigger LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.membership_id IS NULL OR NEW.invalidated_at IS NOT NULL THEN
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(
    hashtextextended(NEW.organization_id::text || NEW.care_plan_version_id::text || NEW.membership_id::text, 0)
  );
  IF EXISTS (
    SELECT 1 FROM care_plan_signature s
     WHERE s.organization_id = NEW.organization_id
       AND s.care_plan_version_id = NEW.care_plan_version_id
       AND s.membership_id = NEW.membership_id
       AND s.invalidated_at IS NULL
  ) THEN
    RAISE EXCEPTION 'duplicate key value violates unique constraint "care_plan_signature_version_membership_uq": membership % already signed a slot of version %', NEW.membership_id, NEW.care_plan_version_id
      USING ERRCODE = 'unique_violation',
            CONSTRAINT = 'care_plan_signature_version_membership_uq';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_care_plan_signature_one_slot_per_membership ON "care_plan_signature";--> statement-breakpoint
CREATE TRIGGER trg_care_plan_signature_one_slot_per_membership
  BEFORE INSERT ON "care_plan_signature"
  FOR EACH ROW EXECUTE FUNCTION enforce_care_plan_signature_one_slot_per_membership();
