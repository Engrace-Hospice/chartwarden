-- GAP-022 -- the PRN wrapper row (`prn_administration`) is now written by the administration commit itself.
-- A PRN dose is, by nature, an ad-hoc administration: PRN orders never materialize a `scheduled_dose`, so the
-- dose has no scheduled-dose siting to copy and `administration_record.provider_entity_id` / `location_id`
-- have been nullable for exactly that case since 0133 (the siting is denormalized from the M6 admission /
-- M17 visit context, which the thin bedside route does not carry). The wrapper row mirrors its
-- administration row, so the same two NOT NULLs must relax or no ad-hoc PRN dose could ever be wrapped --
-- which is how the table stayed empty in production while the reassessment cron and M30's
-- prn_effectiveness measure read it.
--
-- RLS is unaffected: the policy keys on `organization_id` (the tenancy GUC), not on siting; the three-column
-- rule is satisfied whenever the siting is known (scheduled-dose siting is copied through), exactly as for
-- `administration_record`.
ALTER TABLE "prn_administration" ALTER COLUMN "provider_entity_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "prn_administration" ALTER COLUMN "location_id" DROP NOT NULL;
