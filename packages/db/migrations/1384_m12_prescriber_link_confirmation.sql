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
--   link_confirmed_by_membership_id     who: the CHECK below makes it the roster row's own member, so neither another member nor a
--                                       platform operator can confirm on someone's behalf, whatever the application does
--
-- All four are set together or none is. A re-link (or a revoke) clears them in the roster upsert; enrolment also requires the stored
-- mdm id and NPI to equal the current link and the record's current NPI, so a missed clear cannot enrol an unconfirmed link.
-- Declared `contract` only because the compat heuristic treats any ADD CONSTRAINT as enforced against the previous release's writes: in
-- fact the previous release never writes these columns, so an all-null row always satisfies the CHECK and a rollback is safe, but an
-- operator, not the auto-restore, makes that call for a deploy that carries this file. Additive and nullable: the previous release is unaffected. dosespot_prescriber already has RLS, table-level app grants and the M4
-- write-audit trigger (0039), so the new columns inherit all three.
ALTER TABLE "dosespot_prescriber"
  ADD COLUMN IF NOT EXISTS "link_confirmed_mdm_id" uuid,
  ADD COLUMN IF NOT EXISTS "link_confirmed_npi" text,
  ADD COLUMN IF NOT EXISTS "link_confirmed_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "link_confirmed_by_membership_id" uuid,
  ADD CONSTRAINT "dosespot_prescriber_link_confirmation_ck" CHECK (
    ("link_confirmed_mdm_id" IS NULL AND "link_confirmed_npi" IS NULL AND "link_confirmed_at" IS NULL
       AND "link_confirmed_by_membership_id" IS NULL)
    OR ("link_confirmed_mdm_id" IS NOT NULL AND "link_confirmed_npi" ~ '^[0-9]{10}$' AND "link_confirmed_at" IS NOT NULL
       AND "link_confirmed_by_membership_id" = "membership_id")
  );
