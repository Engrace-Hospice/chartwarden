-- compat: expand
-- Slice 2 (tenant pricing) - what the platform carrier needs to write the new tables and the rows slice 2 adds to existing ones.
-- The carrier exists only where scripts/db/provision-runtime-roles.ts has run (the 1332 shape); that script re-grants the same on every
-- run, REVOKE-ing UPDATE first so a re-provision also takes back any table-wide grant. Both must agree.
--   plan, plan_census_band            the plan editor: draft create / edit, publish, archive, new version (bands are replaced on a draft)
--   subscription,
--   subscription_state_history        INSERT only: onboarding step 2 creates the tenant's subscription. No UPDATE: slice 2 never edits one.
--   subscription_contract             INSERT, and UPDATE of the billing service mode alone (the guard trigger also freezes the rest)
--   patient_census_daily              the daily census snapshot (INSERT, UPDATE: the latest observation of a day wins)
--   subscription_statement            the monthly statement (INSERT, UPDATE: a draft is recomputed; a final row is frozen by its trigger)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chartwarden_platform') THEN
    GRANT SELECT ON "plan_census_band", "subscription_contract", "patient_census_daily", "subscription_statement" TO chartwarden_platform;
    GRANT INSERT, UPDATE ON "plan" TO chartwarden_platform;
    GRANT INSERT, UPDATE, DELETE ON "plan_census_band" TO chartwarden_platform;
    GRANT INSERT ON "subscription", "subscription_state_history", "subscription_contract" TO chartwarden_platform;
    GRANT UPDATE ("billing_service_mode", "updated_at") ON "subscription_contract" TO chartwarden_platform;
    GRANT INSERT, UPDATE ON "patient_census_daily", "subscription_statement" TO chartwarden_platform;
  END IF;
END $$;
