-- M15 (GAP-045) — one membership fills at most ONE signer slot per discipline plan version.
--
-- The existing unique index is on (org, version, signer_role) only, so one person could sign every slot
-- of a multi-signer quorum (MSW + RN). The service refuses a second signature by the same membership;
-- this BEFORE INSERT trigger is the DB backstop. The M15 spec (§3.5 D11) lists distinct slots per quorum
-- with count 1 each and never has one person hold two slots, so the rule does not contradict the spec.
--
-- Forward-only and safe on dirty data: signatures are immutable attestations, so this migration neither
-- fails on, nor rewrites, any historical duplicate. A unique index (or a raising pre-check) would hard-fail
-- the auto-deploy if legacy code ever let one person sign two slots; a trigger refuses only NEW duplicates.
-- It raises 23505 naming the constraint the app maps to 409 SIGNER_ALREADY_SIGNED. A transaction-scoped
-- advisory lock on the key serialises concurrent inserts so two concurrent signs cannot both pass.

DROP INDEX IF EXISTS "discipline_care_plan_signature_version_membership_uq";--> statement-breakpoint

CREATE OR REPLACE FUNCTION enforce_discipline_signature_one_slot_per_membership()
RETURNS trigger LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended(NEW.organization_id::text || NEW.version_id::text || NEW.signer_membership_id::text, 0)
  );
  IF EXISTS (
    SELECT 1 FROM discipline_care_plan_signature s
     WHERE s.organization_id = NEW.organization_id
       AND s.version_id = NEW.version_id
       AND s.signer_membership_id = NEW.signer_membership_id
  ) THEN
    RAISE EXCEPTION 'duplicate key value violates unique constraint "discipline_care_plan_signature_version_membership_uq": membership % already signed a slot of version %', NEW.signer_membership_id, NEW.version_id
      USING ERRCODE = 'unique_violation',
            CONSTRAINT = 'discipline_care_plan_signature_version_membership_uq';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_discipline_signature_one_slot_per_membership ON "discipline_care_plan_signature";--> statement-breakpoint
CREATE TRIGGER trg_discipline_signature_one_slot_per_membership
  BEFORE INSERT ON "discipline_care_plan_signature"
  FOR EACH ROW EXECUTE FUNCTION enforce_discipline_signature_one_slot_per_membership();
