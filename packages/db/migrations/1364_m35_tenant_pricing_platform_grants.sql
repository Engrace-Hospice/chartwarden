-- compat: expand
-- Slice 2 (tenant pricing) - what the platform carrier needs to write the new tables and the rows slice 2 adds to existing ones.
-- The carrier exists only where scripts/db/provision-runtime-roles.ts has run (the 1332 shape); that script re-grants the same on every
-- run, REVOKE-ing UPDATE first so a re-provision also takes back any table-wide grant. Both must agree.
--   plan                              the plan editor: INSERT a draft; UPDATE by COLUMN only (the editable price and state columns: never id, slug,
--                                     tier, cadence, family_slug, version, supersedes_plan_id or created_at), so the carrier cannot un-freeze a
--                                     published version by changing its tier; the guard triggers refuse that even to a superuser
--   plan_census_band                  INSERT, DELETE (the bands of a draft are replaced wholesale); never UPDATE, so a band cannot be re-pointed
--   subscription,
--   subscription_state_history        INSERT only: onboarding step 2 creates the tenant's subscription. No UPDATE: slice 2 never edits one.
--   subscription_contract             INSERT only: a signed contract never changes (the guard trigger refuses an UPDATE even to a superuser)
--   subscription_contract_mode        INSERT only: the billing service mode history is append-only (a change is a new row, effective-dated)
--   patient_census_daily              the daily census snapshot (INSERT, UPDATE: the latest observation of a day wins)
--   subscription_statement            the monthly statement (INSERT, UPDATE: a draft is recomputed; a final row is frozen by its trigger)
--   subscription_statement_review     SELECT, INSERT: one row per subscription-month the run could not bill (platform-only; the app role has no grant)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chartwarden_platform') THEN
    GRANT SELECT ON "plan_census_band", "subscription_contract", "subscription_contract_mode", "patient_census_daily", "subscription_statement" TO chartwarden_platform;
    GRANT INSERT ON "plan" TO chartwarden_platform;
    GRANT UPDATE ("name", "description", "currency_code", "base_price_cents", "trial_period_days", "is_active", "valid_from", "valid_to",
                  "deprecated_at", "stripe_product_id", "stripe_price_id", "per_user_price_cents", "billing_software_bps", "managed_billing_bps",
                  "contract_term_months", "implementation_fee_cents", "minimum_monthly_cents", "published_at", "updated_at")
      ON "plan" TO chartwarden_platform;
    GRANT INSERT, DELETE ON "plan_census_band" TO chartwarden_platform;
    GRANT INSERT ON "subscription", "subscription_state_history", "subscription_contract", "subscription_contract_mode" TO chartwarden_platform;
    GRANT INSERT, UPDATE ON "patient_census_daily", "subscription_statement" TO chartwarden_platform;
    GRANT SELECT, INSERT ON "subscription_statement_review" TO chartwarden_platform;
  END IF;
END $$;
