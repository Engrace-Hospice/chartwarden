-- M1 Foundation — TASK-007: re-run the 0118 FORCE-RLS catalog sweep (66 tables enabled after 0118
-- shipped — M28/M29/M35/M37 — were never forced) and close the 11 zero-policy platform tables (RLS
-- enabled, granted to wardenx_admin/tenant_platform_writer, but no policy exists for either role, so
-- the grant is dead: default-deny with zero policies blocks every role except a BYPASSRLS connection).
--
-- Neither half edits an applied migration — both are additive and idempotent, matching 0118's own
-- policy of catalog-driven re-sweeps over hand-maintained table lists.

-- 1. Re-run 0118's idempotent FORCE sweep. M28 (0137), M29 (0148), M35 (0143) and M37 (0153) all
--    shipped after 0118 and used ENABLE ROW LEVEL SECURITY directly, so none of their 66 tables were
--    ever FORCEd — ownership silently exempts them exactly as 0118 describes for the pre-0118 set.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.oid::regclass AS t
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p')
      AND c.relrowsecurity
      AND NOT c.relforcerowsecurity
  LOOP
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', r.t);
  END LOOP;
END $$;--> statement-breakpoint

-- 2. The 11 zero-policy platform tables. Each already has RLS enabled and a GRANT to the role
--    named below (0052/0143/0019) — but with zero CREATE POLICY, that grant is unreachable: RLS
--    enabled + no policy is default-deny for every non-owner role, including the granted one. These
--    were invisible to the "every org-scoped table has a policy" check (rls-isolation.live.test.ts)
--    because none carry organization_id — they are platform-only by design. Adding a permissive
--    `USING (true)` policy for the already-granted role makes the documented access model real
--    without widening it: wardenx_app is still never granted, so tenant connections still see nothing.

-- 2a. M34 tenant_signup_intent / tenant_signup_token (0052) — granted to BOTH tenant_platform_writer
--     (the self-serve signup funnel, pre-organization) and wardenx_admin.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['tenant_signup_intent', 'tenant_signup_token'] LOOP
    EXECUTE format('CREATE POLICY %I_platform_writer_all ON %I FOR ALL TO tenant_platform_writer USING (true) WITH CHECK (true)', t, t);
    EXECUTE format('CREATE POLICY %I_admin_all ON %I FOR ALL TO wardenx_admin USING (true) WITH CHECK (true)', t, t);
  END LOOP;
END $$;--> statement-breakpoint

-- 2b. M35 platform-only Stripe/billing tables (0143) + M40 platform-ops tables (0019) — granted to
--     wardenx_admin only.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'revenue_recognition_snapshot', 'patient_pseudonym_key', 'stripe_webhook_event',
    'stripe_api_call_audit', 'platform_retained_invoice', 'platform_retained_invoice_line',
    'merge_request', 'nppes_sync_log', 'nppes_sync_coordination'
  ] LOOP
    EXECUTE format('CREATE POLICY %I_admin_all ON %I FOR ALL TO wardenx_admin USING (true) WITH CHECK (true)', t, t);
  END LOOP;
END $$;
