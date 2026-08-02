-- M35 Subscription Billing §3.5/§3.6 — RLS + grants on all 21 owned tables and the M4 write-audit
-- trigger on each (bar one). Tables land in 0140 (nine platform-shared/only), 0141 (eleven tenant,
-- unpartitioned) and 0142 (`usage_event`, monthly-partitioned).
--
-- 1. RLS (§3.5 / ADR-0010 D2) — THREE SHAPES.
--
--    • TENANT-SCOPED (twelve): subscription, subscription_state_history, payment_method, invoice,
--      invoice_line, usage_event, usage_period_aggregate, patient_active_period, user_active_period,
--      dunning_state, promo_code_application, refund. One `FOR ALL` policy keyed ONLY on app.org_id
--      (set by withOrgContext()). wardenx_app gets SELECT/INSERT/UPDATE AND DELETE — unlike the M28
--      shred-in-place eraser, M35's §3.7 tenant-offboarding eraser COPIES invoice/invoice_line rows into
--      platform_retained_invoice(_line) (7-year retention) and then DELETES the tenant rows
--      (copy-then-delete, M35-F06), so the tenant tables must permit DELETE. For the partitioned
--      `usage_event` the policy + grants are declared on the PARTITIONED PARENT only; they propagate to
--      every partition (PG11+, the M28 fhir_client_session precedent).
--
--    • PLATFORM CATALOG (three): plan, plan_meter, promo_code. `FOR SELECT USING (true)` to wardenx_app
--      (a tenant must read the pricing/coupon catalog to subscribe); writes only via wardenx_admin (the
--      M28 fhir_capability_snapshot / M38 code_system / M22 form_template precedent). The canonical-RLS-
--      variable rule (ADR-0010 D2, arch:tenancy) permits ONLY app.org_id in a policy, so the platform
--      write control is the ROLE grant, not an app.tenant_scope predicate — architecture wins over the
--      module spec's §3.5 sketch.
--
--    • PLATFORM-ONLY (six): revenue_recognition_snapshot, patient_pseudonym_key, stripe_webhook_event,
--      stripe_api_call_audit, platform_retained_invoice, platform_retained_invoice_line. RLS enabled with
--      NO wardenx_app grant — never exposed to tenant queries; writes flow through the platform Stripe
--      dispatcher / offboarding orchestration as wardenx_admin.
--
-- 2. M4 write-audit triggers (§3.6).
--
--    • payment_method gets a GENERATED scrubbing function (the M4 §3.6 generator shape) denylisting the
--      card_*/ach_*/sepa_* metadata columns (defence-in-depth; org resolved from the ROW).
--    • stripe_webhook_event gets a GENERATED function denylisting payload_ciphertext + payload_dek_ref
--      (envelope-encrypted, D15); its PK is the Stripe TEXT event id, so resource_id is NULL and org is
--      resolved from the session.
--    • usage_event gets a GENERATED function that hard-codes the parent name — M1's baseline trigger
--      would stamp `TG_TABLE_NAME` = the dated PARTITION (the M32 ai_token_ledger lesson); retention
--      `operational`.
--    • patient_pseudonym_key gets NO trigger — §3.6 grants it FULL audit exclusion (the key-rotation
--      timeline must not enter the audit log); it has no organization_id substring, so the phi-guards
--      gate does not force one.
--    • The remaining sixteen tables use M1's baseline `wardenx_audit_trigger()` unchanged: they are
--      unpartitioned with a uuid `id` PK and no secret column, and the baseline resolves organization_id
--      from `to_jsonb(NEW)->>'organization_id'` (falling back to the session where the column is absent or
--      differently named, e.g. platform_retained_invoice.original_organization_id).

-- ============================================================================================
-- 1. RLS policies + grants (§3.5).
-- ============================================================================================
-- 1a. TENANT-SCOPED (twelve): canonical app.org_id isolation; wardenx_app keeps DELETE for the §3.7 eraser.--> statement-breakpoint
ALTER TABLE "subscription" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "subscription_org" ON "subscription";
CREATE POLICY "subscription_org" ON "subscription"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON "subscription" TO wardenx_app;
GRANT ALL ON "subscription" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "subscription_state_history" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "subscription_state_history_org" ON "subscription_state_history";
CREATE POLICY "subscription_state_history_org" ON "subscription_state_history"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON "subscription_state_history" TO wardenx_app;
GRANT ALL ON "subscription_state_history" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "payment_method" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "payment_method_org" ON "payment_method";
CREATE POLICY "payment_method_org" ON "payment_method"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON "payment_method" TO wardenx_app;
GRANT ALL ON "payment_method" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "invoice" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "invoice_org" ON "invoice";
CREATE POLICY "invoice_org" ON "invoice"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON "invoice" TO wardenx_app;
GRANT ALL ON "invoice" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "invoice_line" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "invoice_line_org" ON "invoice_line";
CREATE POLICY "invoice_line_org" ON "invoice_line"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON "invoice_line" TO wardenx_app;
GRANT ALL ON "invoice_line" TO wardenx_admin;--> statement-breakpoint
-- Declared on the PARTITIONED PARENT; propagates to every partition.--> statement-breakpoint
ALTER TABLE "usage_event" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "usage_event_org" ON "usage_event";
CREATE POLICY "usage_event_org" ON "usage_event"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON "usage_event" TO wardenx_app;
GRANT ALL ON "usage_event" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "usage_period_aggregate" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "usage_period_aggregate_org" ON "usage_period_aggregate";
CREATE POLICY "usage_period_aggregate_org" ON "usage_period_aggregate"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON "usage_period_aggregate" TO wardenx_app;
GRANT ALL ON "usage_period_aggregate" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "patient_active_period" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "patient_active_period_org" ON "patient_active_period";
CREATE POLICY "patient_active_period_org" ON "patient_active_period"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON "patient_active_period" TO wardenx_app;
GRANT ALL ON "patient_active_period" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "user_active_period" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "user_active_period_org" ON "user_active_period";
CREATE POLICY "user_active_period_org" ON "user_active_period"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON "user_active_period" TO wardenx_app;
GRANT ALL ON "user_active_period" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "dunning_state" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "dunning_state_org" ON "dunning_state";
CREATE POLICY "dunning_state_org" ON "dunning_state"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON "dunning_state" TO wardenx_app;
GRANT ALL ON "dunning_state" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "promo_code_application" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "promo_code_application_org" ON "promo_code_application";
CREATE POLICY "promo_code_application_org" ON "promo_code_application"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON "promo_code_application" TO wardenx_app;
GRANT ALL ON "promo_code_application" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "refund" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "refund_org" ON "refund";
CREATE POLICY "refund_org" ON "refund"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON "refund" TO wardenx_app;
GRANT ALL ON "refund" TO wardenx_admin;--> statement-breakpoint
-- 1b. PLATFORM CATALOG (three): read-all within any tenant, writes via wardenx_admin only.--> statement-breakpoint
ALTER TABLE "plan" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "plan_read" ON "plan";
CREATE POLICY "plan_read" ON "plan" FOR SELECT TO wardenx_app USING (true);
GRANT SELECT ON "plan" TO wardenx_app;
GRANT ALL ON "plan" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "plan_meter" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "plan_meter_read" ON "plan_meter";
CREATE POLICY "plan_meter_read" ON "plan_meter" FOR SELECT TO wardenx_app USING (true);
GRANT SELECT ON "plan_meter" TO wardenx_app;
GRANT ALL ON "plan_meter" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "promo_code" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "promo_code_read" ON "promo_code";
CREATE POLICY "promo_code_read" ON "promo_code" FOR SELECT TO wardenx_app USING (true);
GRANT SELECT ON "promo_code" TO wardenx_app;
GRANT ALL ON "promo_code" TO wardenx_admin;--> statement-breakpoint
-- 1c. PLATFORM-ONLY (six): RLS enabled, no wardenx_app grant — writes via wardenx_admin only.--> statement-breakpoint
ALTER TABLE "revenue_recognition_snapshot" ENABLE ROW LEVEL SECURITY;
GRANT ALL ON "revenue_recognition_snapshot" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "patient_pseudonym_key" ENABLE ROW LEVEL SECURITY;
GRANT ALL ON "patient_pseudonym_key" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "stripe_webhook_event" ENABLE ROW LEVEL SECURITY;
GRANT ALL ON "stripe_webhook_event" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "stripe_api_call_audit" ENABLE ROW LEVEL SECURITY;
GRANT ALL ON "stripe_api_call_audit" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "platform_retained_invoice" ENABLE ROW LEVEL SECURITY;
GRANT ALL ON "platform_retained_invoice" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "platform_retained_invoice_line" ENABLE ROW LEVEL SECURITY;
GRANT ALL ON "platform_retained_invoice_line" TO wardenx_admin;--> statement-breakpoint

-- ============================================================================================
-- 2. M4 write-audit triggers (§3.6).
-- ============================================================================================
-- 2a. The sixteen baseline tables (unpartitioned, uuid id PK, no secret column).--> statement-breakpoint
CREATE TRIGGER "subscription_audit" AFTER INSERT OR UPDATE OR DELETE ON subscription
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();--> statement-breakpoint
CREATE TRIGGER "subscription_state_history_audit" AFTER INSERT OR UPDATE OR DELETE ON subscription_state_history
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();--> statement-breakpoint
CREATE TRIGGER "invoice_audit" AFTER INSERT OR UPDATE OR DELETE ON invoice
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();--> statement-breakpoint
CREATE TRIGGER "invoice_line_audit" AFTER INSERT OR UPDATE OR DELETE ON invoice_line
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();--> statement-breakpoint
CREATE TRIGGER "usage_period_aggregate_audit" AFTER INSERT OR UPDATE OR DELETE ON usage_period_aggregate
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();--> statement-breakpoint
CREATE TRIGGER "patient_active_period_audit" AFTER INSERT OR UPDATE OR DELETE ON patient_active_period
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();--> statement-breakpoint
CREATE TRIGGER "user_active_period_audit" AFTER INSERT OR UPDATE OR DELETE ON user_active_period
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();--> statement-breakpoint
CREATE TRIGGER "dunning_state_audit" AFTER INSERT OR UPDATE OR DELETE ON dunning_state
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();--> statement-breakpoint
CREATE TRIGGER "promo_code_application_audit" AFTER INSERT OR UPDATE OR DELETE ON promo_code_application
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();--> statement-breakpoint
CREATE TRIGGER "refund_audit" AFTER INSERT OR UPDATE OR DELETE ON refund
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();--> statement-breakpoint
CREATE TRIGGER "plan_audit" AFTER INSERT OR UPDATE OR DELETE ON plan
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();--> statement-breakpoint
CREATE TRIGGER "plan_meter_audit" AFTER INSERT OR UPDATE OR DELETE ON plan_meter
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();--> statement-breakpoint
CREATE TRIGGER "promo_code_audit" AFTER INSERT OR UPDATE OR DELETE ON promo_code
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();--> statement-breakpoint
CREATE TRIGGER "revenue_recognition_snapshot_audit" AFTER INSERT OR UPDATE OR DELETE ON revenue_recognition_snapshot
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();--> statement-breakpoint
CREATE TRIGGER "stripe_api_call_audit_audit" AFTER INSERT OR UPDATE OR DELETE ON stripe_api_call_audit
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();--> statement-breakpoint
CREATE TRIGGER "platform_retained_invoice_audit" AFTER INSERT OR UPDATE OR DELETE ON platform_retained_invoice
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();--> statement-breakpoint
CREATE TRIGGER "platform_retained_invoice_line_audit" AFTER INSERT OR UPDATE OR DELETE ON platform_retained_invoice_line
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();--> statement-breakpoint
-- 2b. payment_method — GENERATED scrub, denylist the card_*/ach_*/sepa_* metadata columns (org from row).--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_payment_method() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
  v_cols text[] := ARRAY['card_brand','card_last4','card_exp_month','card_exp_year','card_wallet_kind','ach_bank_name','ach_account_last4','ach_account_type','sepa_country','sepa_last4']::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'payment_method.' || lower(TG_OP),
    'payment_method',
    COALESCE(NEW.id, OLD.id),
    COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'),
    'success', 'info', v_before, v_after,
    jsonb_build_object(
      'provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), ''),
      'location_id', NULLIF(current_setting('app.location_id', true), '')),
    'compliance'
  );
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_payment_method() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_payment_method" AFTER INSERT OR UPDATE OR DELETE ON payment_method
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_payment_method();--> statement-breakpoint
-- 2c. stripe_webhook_event — GENERATED scrub, denylist the envelope-encrypted payload (D15). TEXT id, so
--     resource_id is NULL and org is resolved from the session.--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_stripe_webhook_event() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
  v_cols text[] := ARRAY['payload_ciphertext','payload_dek_ref']::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    NULLIF(current_setting('app.org_id', true), '')::uuid,
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'system',
    'stripe_webhook_event.' || lower(TG_OP),
    'stripe_webhook_event',
    NULL,
    COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'),
    'success', 'info', v_before, v_after,
    jsonb_build_object('stripe_event_id', COALESCE(NEW.id, OLD.id)),
    'compliance'
  );
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_stripe_webhook_event() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_stripe_webhook_event" AFTER INSERT OR UPDATE OR DELETE ON stripe_webhook_event
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_stripe_webhook_event();--> statement-breakpoint
-- 2d. usage_event — PARTITIONED, so the parent name is hard-coded; retention 'operational' (§3.6).--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_usage_event() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN to_jsonb(OLD) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN to_jsonb(NEW) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'system',
    'usage_event.' || lower(TG_OP),
    'usage_event',
    COALESCE(NEW.id, OLD.id),
    COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'),
    'success', 'info', v_before, v_after,
    jsonb_build_object(
      'provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), ''),
      'location_id', NULLIF(current_setting('app.location_id', true), '')),
    'operational'
  );
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_usage_event() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_usage_event" AFTER INSERT OR UPDATE OR DELETE ON usage_event
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_usage_event();
-- patient_pseudonym_key intentionally has NO write-audit trigger (§3.6 full exclusion).
