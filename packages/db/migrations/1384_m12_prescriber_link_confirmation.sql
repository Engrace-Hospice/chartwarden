-- compat: contract
-- M12: a roster administrator's link from a member to a physician record (`external_physician_mdm_id`) says WHO the member is, and the
-- DoseSpot enrolment sends that record's NPI and legal name to the vendor. The administrator can no longer choose the NPI or the name
-- (they come from the NPPES-sourced record), but the link itself was still one person's assertion about another. The prescriber now
-- confirms it from their own account, shown the record's name and NPI, and the vendor enrolment is refused until the confirmation
-- matches the CURRENT link.
--
--   link_confirmed_mdm_id               the physician record the prescriber confirmed
--   link_confirmed_npi                  the NPI they were shown and confirmed (so a record whose NPI later changed is no longer confirmed)
--   link_confirmed_at                   when
--   link_confirmed_by_membership_id     who: always the roster row's own membership
--
-- WHAT IS ENFORCED WHERE (exactly):
--   * THE CHECK below, on every writer including a superuser: the four columns are set together or none is; a confirmed NPI is ten
--     digits; and the recorded confirmer IS the row's own member (`by = membership_id`) with every column NOT NULL (a NULL operand
--     would otherwise make the comparison NULL, which a CHECK passes). It binds the RECORD to the member; it cannot say who wrote it.
--   * THE TRIGGER below, on every writer that fires triggers (the application role included): setting or changing a confirmation
--     requires the transaction's declared actor `app.user_id` to be that member's own user. `app.user_id` is what the application sets
--     per transaction from the session (`withOrgContext`, the same GUC the write-audit triggers read for `actor_user_id`). So a write
--     that runs under another declared actor (an operator-lane transaction, an administrator's request, a worker, with the empty
--     actor) is refused by the database. It is not authentication: code that can set the GUC could declare any user, so it relies on the
--     application never declaring anyone but the session's user. Clearing a confirmation (all four NULL) is allowed to any actor: a
--     re-link or a revoke does it.
--   * THE APPLICATION: the route (the member's own session, `prescribing.sign`, a fresh step-up, a human actor), the pin to the link and
--     NPI they were shown, and the enrolment gate (the confirmation must be by the row's own member, of the current link and NPI).
--
-- A re-link (or a revoke) clears the columns in the roster upsert; enrolment also requires the stored mdm id and NPI to equal the
-- current link and the record's current NPI, so a missed clear cannot enrol an unconfirmed link.
-- Declared `contract` only because the compat heuristic treats any ADD CONSTRAINT as enforced against the previous release's writes: in
-- fact the previous release never writes these columns, so an all-null row always satisfies the CHECK and a rollback is safe, but an
-- operator, not the auto-restore, makes that call for a deploy that carries this file. Additive and nullable: the previous release is
-- unaffected. dosespot_prescriber already has RLS, table-level app grants and the M4 write-audit trigger (0039), so the new columns
-- inherit all three (the write-audit row records the NPI like any column of this table: it is public provider data).
ALTER TABLE "dosespot_prescriber"
  ADD COLUMN IF NOT EXISTS "link_confirmed_mdm_id" uuid,
  ADD COLUMN IF NOT EXISTS "link_confirmed_npi" text,
  ADD COLUMN IF NOT EXISTS "link_confirmed_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "link_confirmed_by_membership_id" uuid,
  ADD CONSTRAINT "dosespot_prescriber_link_confirmation_ck" CHECK (
    ("link_confirmed_mdm_id" IS NULL AND "link_confirmed_npi" IS NULL AND "link_confirmed_at" IS NULL
       AND "link_confirmed_by_membership_id" IS NULL)
    OR ("link_confirmed_mdm_id" IS NOT NULL AND "link_confirmed_npi" IS NOT NULL AND "link_confirmed_npi" ~ '^[0-9]{10}$'
       AND "link_confirmed_at" IS NOT NULL AND "link_confirmed_by_membership_id" IS NOT NULL
       AND "link_confirmed_by_membership_id" = "membership_id")
  );--> statement-breakpoint

CREATE OR REPLACE FUNCTION dosespot_prescriber_link_confirmation_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  changed boolean;
  actor uuid;
BEGIN
  IF NEW.link_confirmed_mdm_id IS NULL THEN
    RETURN NEW; -- clearing (or never set) is open to any actor: a re-link or a revoke does it
  END IF;
  IF TG_OP = 'UPDATE' THEN
    changed := (NEW.link_confirmed_mdm_id, NEW.link_confirmed_npi, NEW.link_confirmed_at, NEW.link_confirmed_by_membership_id)
      IS DISTINCT FROM (OLD.link_confirmed_mdm_id, OLD.link_confirmed_npi, OLD.link_confirmed_at, OLD.link_confirmed_by_membership_id);
  ELSE
    changed := true;
  END IF;
  IF NOT changed THEN
    RETURN NEW; -- an unrelated update of a row that is already confirmed
  END IF;
  actor := NULLIF(current_setting('app.user_id', true), '')::uuid;
  IF actor IS NULL
     OR NEW.link_confirmed_by_membership_id IS DISTINCT FROM NEW.membership_id
     OR NOT EXISTS (SELECT 1 FROM membership m WHERE m.id = NEW.membership_id AND m.user_id = actor) THEN
    RAISE EXCEPTION 'dosespot_prescriber: a link confirmation can only be set by the member it belongs to, acting as themself (app.user_id)'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

DROP TRIGGER IF EXISTS "trg_dosespot_prescriber_link_confirmation" ON "dosespot_prescriber";--> statement-breakpoint
CREATE TRIGGER "trg_dosespot_prescriber_link_confirmation" BEFORE INSERT OR UPDATE ON "dosespot_prescriber"
  FOR EACH ROW EXECUTE FUNCTION dosespot_prescriber_link_confirmation_guard();
