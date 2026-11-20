-- compat: expand
-- M8 visit-note drafting (ADR-0114, design 3.1): the signed narrative is frozen IN THE DATABASE. `hearthnote_assembled_output.final_cipher`
-- (and layer1_cipher / layer2_cipher) are what a signed note SAYS, and the sealed per-section rows of 1518 must equal them; 0031 granted the
-- application role UPDATE on the table for the finalize/sign pin and nothing stopped a later UPDATE, so "frozen per section" was code, not a
-- guarantee. This BEFORE UPDATE trigger refuses any change to the three ciphers once the parent encounter (an addendum's output: the addendum's
-- encounter) is `signed`, `cosign_pending` or `cosigned`.
--   * Sign pins final_cipher / layer1_cipher while the encounter is still `finalized` and flips the status AFTER (encounters-route-service-db
--     sign path: the pin runs before the status UPDATE, in the same transaction, which is what keeps the pin writable here).
--   * The one exception is the eraser: a non-superuser member of chartwarden_destruction (the 1298 / 1061 shape) writing the shred sentinel
--     '' (or NULL for the nullable layer2_cipher), which tenant destruction does to a signed note; any other value from that role is refused
--     like the application role's.
--   * A write that changes no cipher is not refused. A parent encounter that cannot be read fails CLOSED (refused).
--   * SECURITY INVOKER, so the encounter read runs under the caller's RLS (the 1514 / 1517 guard shape). Refusal is restrict_violation (23001).
-- Roles are the post-1139 names (chartwarden_*).

CREATE OR REPLACE FUNCTION hearthnote_assembled_output_frozen_after_sign() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_status text;
BEGIN
  IF NEW.layer1_cipher IS NOT DISTINCT FROM OLD.layer1_cipher
     AND NEW.layer2_cipher IS NOT DISTINCT FROM OLD.layer2_cipher
     AND NEW.final_cipher IS NOT DISTINCT FROM OLD.final_cipher THEN
    RETURN NEW;
  END IF;
  IF pg_has_role(current_user, 'chartwarden_destruction', 'MEMBER')
     AND NOT (SELECT r.rolsuper FROM pg_catalog.pg_roles r WHERE r.rolname = current_user)
     AND (NEW.layer1_cipher IS NOT DISTINCT FROM OLD.layer1_cipher OR NEW.layer1_cipher = '')
     AND (NEW.layer2_cipher IS NOT DISTINCT FROM OLD.layer2_cipher OR NEW.layer2_cipher IS NULL OR NEW.layer2_cipher = '')
     AND (NEW.final_cipher IS NOT DISTINCT FROM OLD.final_cipher OR NEW.final_cipher = '') THEN
    RETURN NEW;
  END IF;
  SELECT e.status::text INTO v_status
    FROM encounter e
   WHERE e.id = COALESCE(NEW.encounter_id, (SELECT a.encounter_id FROM encounter_addendum a WHERE a.id = NEW.addendum_id));
  IF v_status IS NULL OR v_status IN ('signed', 'cosign_pending', 'cosigned') THEN
    RAISE EXCEPTION 'hearthnote_assembled_output: the narrative of a signed encounter is frozen (a cipher change was rejected)'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_hearthnote_assembled_output_frozen_after_sign"
  BEFORE UPDATE ON "hearthnote_assembled_output"
  FOR EACH ROW EXECUTE FUNCTION hearthnote_assembled_output_frozen_after_sign();
