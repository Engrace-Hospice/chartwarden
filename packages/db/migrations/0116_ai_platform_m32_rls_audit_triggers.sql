-- M32 AI Platform §3.3/§3.4/§3.5 — RLS + grants on all thirteen owned tables, the M4 write-audit
-- trigger on each, and the five immutability triggers. Tables land in 0113 (eleven unpartitioned),
-- 0114 (`ai_invocation`) and 0115 (`ai_token_ledger`).
--
-- 1. RLS (§3.3 / ADR-0010 D2) — THREE SHAPES, and the third is the one that matters.
--
--    • PLATFORM-SHARED (six): ai_capability, ai_capability_lifecycle_event, ai_capability_calibration,
--      ai_model_backend, ai_prompt_template, ai_evaluation_run. `FOR SELECT USING (true)` to
--      wardenx_app; wardenx_app gets SELECT and NOTHING ELSE, so the governance surface is readable
--      inside every tenant and writable only by wardenx_admin (System Design §4.6; the M38 code_system /
--      M22 form_template / M21 supply_item precedent). Read-all is deliberate: a tenant cannot opt in to
--      a capability it cannot see, and a per-tenant copy of the model registry would let two tenants
--      disagree about which model version answered.
--
--    • TENANT-SCOPED (six): ai_tenant_opt_in_record, ai_clinician_opt_out, ai_invocation,
--      ai_token_ledger, ai_hallucination_report, ai_routing_override. One `FOR ALL` policy keyed ONLY on
--      app.org_id, set by withOrgContext(). The layered checks the module needs on top (the AI Safety
--      Owner's cross-capability console, the §4.7 opt-in / opt-out / kill-switch / token-budget
--      predicates) are M3 ABAC at the route, never RLS: RLS is the tenant moat, ABAC is the per-record
--      filter. For `ai_invocation` and `ai_token_ledger` the policy and grants are declared on the
--      PARTITIONED PARENT only; they propagate to every partition (PG11+, the M16/M21/M25/M30 precedent).
--
--    • MIXED (one): ai_kill_switch_state, whose organization_id is NULLABLE and whose NULL row is a
--      PLATFORM-WIDE kill. It gets THREE policies split BY COMMAND — SELECT that also admits the
--      platform row, INSERT and UPDATE that admit only rows carrying the caller's own org. That
--      asymmetry IS the control: a single `FOR ALL` policy would let any tenant admin mint a NULL-org
--      row and stop the capability for every other tenant on the platform, so W3's platform-wide
--      activation goes through wardenx_admin. (Two permissive `FOR ALL` policies on one table also OR
--      together, the shape ADR-0010 D3 forbids — the M19 triage_protocol / M21 comfort_kit_template
--      precedent.)
--
--    GRANTS: wardenx_app gets DELETE on NOTHING anywhere in M32. `ai_invocation` in particular is the
--    §164.528 disclosure ledger and §3.7's destruction is a DEK shred, not a row delete — withholding
--    the privilege makes an attempted delete a permission error rather than a code-review convention,
--    and the 0116 trigger refuses it a second time for wardenx_admin. `ai_token_ledger` and
--    `ai_capability_lifecycle_event` get SELECT/INSERT only: both are append-only by §3.5.
--
-- 2. M4 write-audit triggers (§3.4). WHICH TABLES GET A GENERATED FUNCTION is a rule, not a taste:
--    a table gets one exactly when M1's baseline `wardenx_audit_trigger()` would be WRONG for it, which
--    happens for three reasons — a non-empty §3.4 denylist (the baseline does not scrub), an ADR-0004
--    retention class other than the baseline's hard-coded 'compliance', or a PARTITIONED table. That is
--    eight of the thirteen:
--
--      ai_capability_lifecycle_event   stage_artifacts, rationale_text          (platform-shared)
--      ai_prompt_template              clinical_reviewer_attestation            (platform-shared)
--      ai_invocation                   prompt_payload_cipher, response_payload_cipher,
--                                      chart_context_cipher, error_message      (also partitioned)
--      ai_hallucination_report         reporter_narrative_cipher
--      ai_tenant_opt_in_record         disclosure_acknowledgments,
--                                      calibration_trade_off_acknowledged
--      ai_clinician_opt_out            reason
--      ai_routing_override             (empty denylist — generated for retention 'operational')
--      ai_token_ledger                 (empty denylist, 'compliance' — generated because PARTITIONED)
--
--    THE PARTITION CONDITION IS NOT THEORETICAL, and it was found by applying these migrations to a real
--    PostgreSQL rather than by reading them. The baseline trigger stamps `TG_TABLE_NAME` into both
--    `resource_kind` and `event_type`, and a write to a partitioned table fires the trigger with
--    TG_TABLE_NAME = THE PARTITION: an insert landed as `resource_kind = 'ai_token_ledger_2026_08'`,
--    `event_type = 'ai_token_ledger_2026_08.insert'`. Every audit query for the token ledger would
--    return nothing, and the resource kind would change name every month. The generated functions
--    hard-code the parent's name, which is why `ai_invocation` never had the problem.
--
--    The remaining five (ai_capability, ai_capability_calibration, ai_model_backend, ai_evaluation_run,
--    ai_kill_switch_state) carry empty denylists, file as 'compliance' and are unpartitioned, so they use
--    M1's baseline trigger unchanged (the M21 supply_item / M22 form_template precedent). The lists
--    mirror `M32_AUDIT_DENYLIST` in @chartwarden/types VERBATIM so the code-side view and the DB-side scrub
--    cannot drift; `apps/backend/__tests__/ai-platform-schema.test.ts` compares them.
--
--    THE TWO PLATFORM-SHARED GENERATED FUNCTIONS resolve organization_id from the SESSION rather than
--    from the row, because these tables have no organization_id column at all. `audit_event`'s
--    organization_id is nullable, so a platform-admin write with no tenant context records NULL — which
--    is the honest answer, not a defect: the transition was not made inside any tenant.
--
--    WHAT IS DELIBERATELY *NOT* DENYLISTED, and it is the more important half. `zdr_confirmed`,
--    `routing_decision`, `routing_reason`, `model_version_pin`, `status`, `hitl_outcome`, `severity`,
--    `hallucination_kind`, `lifecycle_state` and `risk_tier` are captured VERBATIM. They are exactly the
--    fields a §164.528 accounting, an FDA inquiry or a deposition reads; `zdr_confirmed` is the entire
--    D19 claim, and a scrubbed marker there would make the ledger useless for the purpose it exists to
--    serve. Only the free text and the opaque ciphers are scrubbed.
--
--    RETENTION CLASS NOTE: `audit_event.retention_class` is M1's `audit_retention_class` enum
--    (operational | compliance | legal_hold | compliance_42cfr_part2). That axis is the AUDIT ROW's
--    retention; the M4 eraser DATA CLASS for the M32 rows themselves (§3.7's two AI-provenance classes)
--    is a different axis registered through M4's destruction-cert registry. Both apply. `ai_token_ledger`
--    stamps 'compliance' even though §3.8 gives its partitions a 6-year horizon against
--    `ai_invocation`'s 7: the shorter horizon is a partition-drop policy, not a second class.
--
-- 3. §3.5 immutability triggers — five tables, three shapes.
--
--    APPEND-ONLY (UPDATE and DELETE both refused): `ai_capability_lifecycle_event` and
--    `ai_token_ledger`. The lifecycle ledger is what an FDA inquiry reads to answer "who approved this
--    and on what evidence", and an edited approval is indistinguishable from an approval that never
--    happened — a correction is a NEW transition row. The token ledger IS the W2 hard cap (the cap is
--    the sum of these rows), and a mutable row makes that sum a claim rather than a total.
--
--    COLUMN-RESTRICTED: `ai_invocation`, `ai_capability_calibration`, `ai_prompt_template`. The
--    invocation row is INSERTed BEFORE the backend answers, so §3.5's "append-only post-completion" can
--    only be enforced as a FROZEN COLUMN SET: the request side and the provenance (`organization_id`,
--    `capability_id`, the three ciphers, both token counts, `model_version_pin`,
--    `prompt_template_version`, `zdr_confirmed`, `invoked_at`) cannot change, while `status`,
--    `completed_at`, `duration_ms`, `error_*` and `hitl_outcome` stay writable — `hitl_outcome` in
--    particular is written later still, by the consumer module recording the human's accept/edit/reject.
--    DELETE is refused outright on all three.
--
--    `ai_prompt_template` additionally enforces the D3 status walk: active → deprecated → archived, one
--    direction only. Un-deprecating a template would silently put a withdrawn prompt back in
--    `AIPromptRegistry`'s active set, which is the exact failure the D18 prohibited-zone check exists to
--    prevent.
--
--    The trigger on `ai_capability_calibration` is what makes supersession a supersession: the frozen
--    set is the calibration CONTENT (thresholds, baseline metrics, the baseline's provenance), so the
--    only legal UPDATE is flipping `is_current` false and filling the `superseded_*` columns.
--
--    All five are BEFORE triggers so the refusal happens before the write, and they are declared on the
--    partitioned PARENT where applicable (BEFORE ROW triggers on partitioned tables, PG13+).

-- ============================================================================================
-- 1. RLS policies + grants (§3.3).
-- ============================================================================================
-- PLATFORM-SHARED: read-all within any tenant, writes via wardenx_admin only.--> statement-breakpoint
ALTER TABLE "ai_capability" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ai_capability_read" ON "ai_capability";
CREATE POLICY "ai_capability_read" ON "ai_capability"
  FOR SELECT TO wardenx_app USING (true);
GRANT SELECT ON "ai_capability" TO wardenx_app;
GRANT ALL ON "ai_capability" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "ai_capability_lifecycle_event" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ai_cap_lifecycle_event_read" ON "ai_capability_lifecycle_event";
CREATE POLICY "ai_cap_lifecycle_event_read" ON "ai_capability_lifecycle_event"
  FOR SELECT TO wardenx_app USING (true);
GRANT SELECT ON "ai_capability_lifecycle_event" TO wardenx_app;
GRANT ALL ON "ai_capability_lifecycle_event" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "ai_capability_calibration" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ai_cap_calibration_read" ON "ai_capability_calibration";
CREATE POLICY "ai_cap_calibration_read" ON "ai_capability_calibration"
  FOR SELECT TO wardenx_app USING (true);
GRANT SELECT ON "ai_capability_calibration" TO wardenx_app;
GRANT ALL ON "ai_capability_calibration" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "ai_model_backend" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ai_model_backend_read" ON "ai_model_backend";
CREATE POLICY "ai_model_backend_read" ON "ai_model_backend"
  FOR SELECT TO wardenx_app USING (true);
GRANT SELECT ON "ai_model_backend" TO wardenx_app;
GRANT ALL ON "ai_model_backend" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "ai_prompt_template" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ai_prompt_template_read" ON "ai_prompt_template";
CREATE POLICY "ai_prompt_template_read" ON "ai_prompt_template"
  FOR SELECT TO wardenx_app USING (true);
GRANT SELECT ON "ai_prompt_template" TO wardenx_app;
GRANT ALL ON "ai_prompt_template" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "ai_evaluation_run" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ai_evaluation_run_read" ON "ai_evaluation_run";
CREATE POLICY "ai_evaluation_run_read" ON "ai_evaluation_run"
  FOR SELECT TO wardenx_app USING (true);
GRANT SELECT ON "ai_evaluation_run" TO wardenx_app;
GRANT ALL ON "ai_evaluation_run" TO wardenx_admin;--> statement-breakpoint
-- TENANT-SCOPED: canonical app.org_id isolation, no DELETE for wardenx_app.--> statement-breakpoint
ALTER TABLE "ai_tenant_opt_in_record" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ai_tenant_opt_in_org" ON "ai_tenant_opt_in_record";
CREATE POLICY "ai_tenant_opt_in_org" ON "ai_tenant_opt_in_record"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "ai_tenant_opt_in_record" TO wardenx_app;
GRANT ALL ON "ai_tenant_opt_in_record" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "ai_clinician_opt_out" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ai_clinician_opt_out_org" ON "ai_clinician_opt_out";
CREATE POLICY "ai_clinician_opt_out_org" ON "ai_clinician_opt_out"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "ai_clinician_opt_out" TO wardenx_app;
GRANT ALL ON "ai_clinician_opt_out" TO wardenx_admin;--> statement-breakpoint
-- Declared on the PARTITIONED PARENT; propagates to every partition.--> statement-breakpoint
ALTER TABLE "ai_invocation" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ai_invocation_org" ON "ai_invocation";
CREATE POLICY "ai_invocation_org" ON "ai_invocation"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "ai_invocation" TO wardenx_app;
GRANT ALL ON "ai_invocation" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "ai_token_ledger" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ai_token_ledger_org" ON "ai_token_ledger";
CREATE POLICY "ai_token_ledger_org" ON "ai_token_ledger"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT ON "ai_token_ledger" TO wardenx_app;
GRANT ALL ON "ai_token_ledger" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "ai_hallucination_report" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ai_hallucination_report_org" ON "ai_hallucination_report";
CREATE POLICY "ai_hallucination_report_org" ON "ai_hallucination_report"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "ai_hallucination_report" TO wardenx_app;
GRANT ALL ON "ai_hallucination_report" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "ai_routing_override" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ai_routing_override_org" ON "ai_routing_override";
CREATE POLICY "ai_routing_override_org" ON "ai_routing_override"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "ai_routing_override" TO wardenx_app;
GRANT ALL ON "ai_routing_override" TO wardenx_admin;--> statement-breakpoint
-- MIXED SCOPE: read the platform-wide kill, write only your own (see the header).--> statement-breakpoint
ALTER TABLE "ai_kill_switch_state" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ai_kill_switch_read" ON "ai_kill_switch_state";
DROP POLICY IF EXISTS "ai_kill_switch_insert" ON "ai_kill_switch_state";
DROP POLICY IF EXISTS "ai_kill_switch_update" ON "ai_kill_switch_state";
CREATE POLICY "ai_kill_switch_read" ON "ai_kill_switch_state"
  FOR SELECT TO wardenx_app
  USING (organization_id IS NULL OR organization_id = current_setting('app.org_id', true)::uuid);
CREATE POLICY "ai_kill_switch_insert" ON "ai_kill_switch_state"
  FOR INSERT TO wardenx_app
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
CREATE POLICY "ai_kill_switch_update" ON "ai_kill_switch_state"
  FOR UPDATE TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "ai_kill_switch_state" TO wardenx_app;
GRANT ALL ON "ai_kill_switch_state" TO wardenx_admin;--> statement-breakpoint

-- ============================================================================================
-- 2. M4 write-audit triggers (§3.4).
-- ============================================================================================
-- 2a. The six empty-denylist / 'compliance' tables use M1's baseline trigger unchanged.--> statement-breakpoint
CREATE TRIGGER "ai_capability_audit" AFTER INSERT OR UPDATE OR DELETE ON ai_capability
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();--> statement-breakpoint
CREATE TRIGGER "ai_capability_calibration_audit" AFTER INSERT OR UPDATE OR DELETE ON ai_capability_calibration
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();--> statement-breakpoint
CREATE TRIGGER "ai_model_backend_audit" AFTER INSERT OR UPDATE OR DELETE ON ai_model_backend
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();--> statement-breakpoint
CREATE TRIGGER "ai_evaluation_run_audit" AFTER INSERT OR UPDATE OR DELETE ON ai_evaluation_run
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();--> statement-breakpoint
CREATE TRIGGER "ai_kill_switch_state_audit" AFTER INSERT OR UPDATE OR DELETE ON ai_kill_switch_state
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();--> statement-breakpoint
-- 2b. The two PLATFORM-SHARED generated functions — org resolved from the SESSION (no column exists).--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_ai_capability_lifecycle_event() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
  v_cols text[] := ARRAY['stage_artifacts','rationale_text']::text[];
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
    'user',
    'ai_capability_lifecycle_event.' || lower(TG_OP),
    'ai_capability_lifecycle_event',
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
ALTER FUNCTION audit_phi_write_ai_capability_lifecycle_event() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_ai_capability_lifecycle_event" AFTER INSERT OR UPDATE OR DELETE ON ai_capability_lifecycle_event
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_ai_capability_lifecycle_event();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_ai_prompt_template() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
  v_cols text[] := ARRAY['clinical_reviewer_attestation']::text[];
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
    'user',
    'ai_prompt_template.' || lower(TG_OP),
    'ai_prompt_template',
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
ALTER FUNCTION audit_phi_write_ai_prompt_template() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_ai_prompt_template" AFTER INSERT OR UPDATE OR DELETE ON ai_prompt_template
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_ai_prompt_template();--> statement-breakpoint
-- 2c. The five TENANT-SCOPED generated functions — org from the row (the M4 generator shape).--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_ai_invocation() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
  v_cols text[] := ARRAY['prompt_payload_cipher','response_payload_cipher','chart_context_cipher','error_message']::text[];
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
    'ai_invocation.' || lower(TG_OP),
    'ai_invocation',
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
ALTER FUNCTION audit_phi_write_ai_invocation() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_ai_invocation" AFTER INSERT OR UPDATE OR DELETE ON ai_invocation
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_ai_invocation();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_ai_hallucination_report() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
  v_cols text[] := ARRAY['reporter_narrative_cipher']::text[];
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
    'ai_hallucination_report.' || lower(TG_OP),
    'ai_hallucination_report',
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
ALTER FUNCTION audit_phi_write_ai_hallucination_report() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_ai_hallucination_report" AFTER INSERT OR UPDATE OR DELETE ON ai_hallucination_report
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_ai_hallucination_report();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_ai_tenant_opt_in_record() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
  v_cols text[] := ARRAY['disclosure_acknowledgments','calibration_trade_off_acknowledged']::text[];
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
    'ai_tenant_opt_in_record.' || lower(TG_OP),
    'ai_tenant_opt_in_record',
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
ALTER FUNCTION audit_phi_write_ai_tenant_opt_in_record() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_ai_tenant_opt_in_record" AFTER INSERT OR UPDATE OR DELETE ON ai_tenant_opt_in_record
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_ai_tenant_opt_in_record();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_ai_clinician_opt_out() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
  v_cols text[] := ARRAY['reason']::text[];
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
    'ai_clinician_opt_out.' || lower(TG_OP),
    'ai_clinician_opt_out',
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
ALTER FUNCTION audit_phi_write_ai_clinician_opt_out() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_ai_clinician_opt_out" AFTER INSERT OR UPDATE OR DELETE ON ai_clinician_opt_out
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_ai_clinician_opt_out();--> statement-breakpoint
-- Empty denylist, but retention class 'operational' rather than the baseline's 'compliance' (§3.4).--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_ai_routing_override() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
  v_cols text[] := ARRAY[]::text[];
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
    'ai_routing_override.' || lower(TG_OP),
    'ai_routing_override',
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
ALTER FUNCTION audit_phi_write_ai_routing_override() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_ai_routing_override" AFTER INSERT OR UPDATE OR DELETE ON ai_routing_override
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_ai_routing_override();--> statement-breakpoint
-- Empty denylist and retention 'compliance', but PARTITIONED — see the header's third condition.--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_ai_token_ledger() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
  v_cols text[] := ARRAY[]::text[];
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
    'ai_token_ledger.' || lower(TG_OP),
    'ai_token_ledger',
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
ALTER FUNCTION audit_phi_write_ai_token_ledger() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_ai_token_ledger" AFTER INSERT OR UPDATE OR DELETE ON ai_token_ledger
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_ai_token_ledger();--> statement-breakpoint

-- ============================================================================================
-- 3. §3.5 immutability triggers.
-- ============================================================================================
-- APPEND-ONLY: the D2 governance ledger. A correction is a NEW transition row.--> statement-breakpoint
CREATE OR REPLACE FUNCTION m32_ai_cap_lifecycle_event_append_only() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'M32_LIFECYCLE_EVENT_APPEND_ONLY: ai_capability_lifecycle_event refuses % — record a new transition row instead (§3.5)', TG_OP
    USING ERRCODE = 'restrict_violation';
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_ai_cap_lifecycle_event_append_only" BEFORE UPDATE OR DELETE ON ai_capability_lifecycle_event
  FOR EACH ROW EXECUTE FUNCTION m32_ai_cap_lifecycle_event_append_only();--> statement-breakpoint
-- APPEND-ONLY: the token ledger IS the W2 hard cap. A correction is a compensating row.--> statement-breakpoint
CREATE OR REPLACE FUNCTION m32_ai_token_ledger_append_only() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'M32_TOKEN_LEDGER_APPEND_ONLY: ai_token_ledger refuses % — post a compensating accrual instead (§3.5)', TG_OP
    USING ERRCODE = 'restrict_violation';
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_ai_token_ledger_append_only" BEFORE UPDATE OR DELETE ON ai_token_ledger
  FOR EACH ROW EXECUTE FUNCTION m32_ai_token_ledger_append_only();--> statement-breakpoint
-- COLUMN-RESTRICTED: the invocation's request side + provenance are frozen; the response side and
-- hitl_outcome stay writable, because the row is INSERTed before the backend answers. DELETE refused —
-- destruction is §3.7's DEK shred, not a row delete.--> statement-breakpoint
CREATE OR REPLACE FUNCTION m32_ai_invocation_immutable_columns() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'M32_INVOCATION_NO_DELETE: ai_invocation is the §164.528 disclosure ledger — destruction is a DEK shred, not a delete (§3.5/§3.7)'
      USING ERRCODE = 'restrict_violation';
  END IF;
  -- THE ONE PERMITTED EDIT TO A CIPHER IS ITS DESTRUCTION (§3.7). A payload may be replaced by the
  -- shred sentinel — the empty bytea for the NOT NULL prompt cipher, NULL for the two optional ones —
  -- and by nothing else. That is what lets the M4 destruction path run with no privileged bypass and no
  -- new session variable: the only cipher write the trigger admits is the one that removes data, and
  -- the write-audit trigger records it either way.
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.capability_id IS DISTINCT FROM OLD.capability_id
     OR (NEW.prompt_payload_cipher IS DISTINCT FROM OLD.prompt_payload_cipher
         AND NEW.prompt_payload_cipher IS DISTINCT FROM ''::bytea)
     OR (NEW.response_payload_cipher IS DISTINCT FROM OLD.response_payload_cipher
         AND NEW.response_payload_cipher IS NOT NULL)
     OR (NEW.chart_context_cipher IS DISTINCT FROM OLD.chart_context_cipher
         AND NEW.chart_context_cipher IS NOT NULL)
     OR NEW.input_token_count IS DISTINCT FROM OLD.input_token_count
     OR NEW.output_token_count IS DISTINCT FROM OLD.output_token_count
     OR NEW.model_version_pin IS DISTINCT FROM OLD.model_version_pin
     OR NEW.prompt_template_version IS DISTINCT FROM OLD.prompt_template_version
     OR NEW.zdr_confirmed IS DISTINCT FROM OLD.zdr_confirmed
     OR NEW.invoked_at IS DISTINCT FROM OLD.invoked_at THEN
    RAISE EXCEPTION 'M32_INVOCATION_FROZEN_COLUMN: ai_invocation refuses an UPDATE to its request side or provenance (§3.5)'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_ai_invocation_immutable_columns" BEFORE UPDATE OR DELETE ON ai_invocation
  FOR EACH ROW EXECUTE FUNCTION m32_ai_invocation_immutable_columns();--> statement-breakpoint
-- COLUMN-RESTRICTED: the only legal UPDATE to a calibration is the supersession flip.--> statement-breakpoint
CREATE OR REPLACE FUNCTION m32_ai_cap_calibration_immutable_columns() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'M32_CALIBRATION_NO_DELETE: ai_capability_calibration keeps its history — supersede instead (§3.5)'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.capability_id IS DISTINCT FROM OLD.capability_id
     OR NEW.backend_key IS DISTINCT FROM OLD.backend_key
     OR NEW.thresholds IS DISTINCT FROM OLD.thresholds
     OR NEW.baseline_metrics IS DISTINCT FROM OLD.baseline_metrics
     OR NEW.baseline_set_at IS DISTINCT FROM OLD.baseline_set_at
     OR NEW.baseline_evaluation_run_id IS DISTINCT FROM OLD.baseline_evaluation_run_id THEN
    RAISE EXCEPTION 'M32_CALIBRATION_FROZEN_COLUMN: a calibration''s content is immutable — insert a superseding row (§3.5)'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_ai_cap_calibration_immutable_columns" BEFORE UPDATE OR DELETE ON ai_capability_calibration
  FOR EACH ROW EXECUTE FUNCTION m32_ai_cap_calibration_immutable_columns();--> statement-breakpoint
-- COLUMN-RESTRICTED + the D3 one-way status walk. Un-deprecating a template would silently return a
-- withdrawn prompt to AIPromptRegistry's active set — the exact failure the D18 check exists to prevent.--> statement-breakpoint
CREATE OR REPLACE FUNCTION m32_ai_prompt_template_immutable_columns() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'M32_PROMPT_TEMPLATE_NO_DELETE: a 2031 audit of a 2026 invocation must still resolve its template — archive instead (§3.5)'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.template_key IS DISTINCT FROM OLD.template_key
     OR NEW.capability_key IS DISTINCT FROM OLD.capability_key
     OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.template_filesystem_ref IS DISTINCT FROM OLD.template_filesystem_ref
     OR NEW.template_content_hash IS DISTINCT FROM OLD.template_content_hash
     OR NEW.compatible_backend_keys IS DISTINCT FROM OLD.compatible_backend_keys
     OR NEW.input_schema_ref IS DISTINCT FROM OLD.input_schema_ref
     OR NEW.output_schema_ref IS DISTINCT FROM OLD.output_schema_ref
     OR NEW.output_entity_target_prefix IS DISTINCT FROM OLD.output_entity_target_prefix
     OR NEW.output_type_prefix IS DISTINCT FROM OLD.output_type_prefix THEN
    RAISE EXCEPTION 'M32_PROMPT_TEMPLATE_FROZEN_COLUMN: a prompt template''s content is immutable — publish a new version (§3.5)'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT ((OLD.status = 'active' AND NEW.status = 'deprecated')
              OR (OLD.status = 'deprecated' AND NEW.status = 'archived')) THEN
    RAISE EXCEPTION 'M32_PROMPT_TEMPLATE_STATUS_WALK: % -> % is not on the active->deprecated->archived path (D3/§3.5)', OLD.status, NEW.status
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_ai_prompt_template_immutable_columns" BEFORE UPDATE OR DELETE ON ai_prompt_template
  FOR EACH ROW EXECUTE FUNCTION m32_ai_prompt_template_immutable_columns();
