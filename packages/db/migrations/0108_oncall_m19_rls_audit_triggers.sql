-- M19 On-Call Triage §3.5 / §3.6 / §2.3 — RLS + grants on all ten owned tables, the M4 write-audit trigger
-- (generateAuditTrigger shape) on each with the §3.6 denylists, and the §2.3 forward-transition guard on
-- `triage_call`. Enums + tables land in 0107.
--
-- 1. RLS (§3.5 / ADR-0010 D2): row visibility keys ONLY on app.org_id, set by withOrgContext(). The four
--    call tables carry provider_entity_id + location_id for the §4.3 seam rollups, but the RLS pivot stays
--    organization_id ALONE — a second permissive policy would OR, not AND. Everything §6/§8.2 layers on top
--    (the `oncall_eligible` / `triage_call_owner_or_supervisor` / `external_triage_actor` predicates, the
--    M39 SUD gate, the §7.10 vendor minimization) is M3 ABAC at the route, never RLS: RLS is the tenant
--    moat, ABAC is the per-record filter.
--
--    TWO SHAPES, not one:
--      • Eight tables get the canonical org policy (`FOR ALL` on organization_id).
--      • `triage_protocol` + `triage_protocol_question` are floor-plus-overlay (D4). Their organization_id
--        is NULLABLE on the platform-floor row ONLY, paired with the `is_system_locked` discriminator and
--        the CHECK pair in 0107. They get THREE policies — SELECT that also admits the floor, INSERT and
--        UPDATE that admit only the tenant's own UNLOCKED rows — rather than one `FOR ALL`, so a tenant
--        READS the floor and can never write it. Split by command on purpose: two permissive `FOR ALL`
--        policies on one table OR together, which is the shape ADR-0010 D3 forbids. This is what makes D4's
--        "tenants may NOT remove or alter platform-floor protocols" a database fact rather than a route
--        convention — and with it, the D7 mandatory-escalation flags on the floor protocols cannot be
--        cleared by the tenant they would otherwise protect.
--
--    Grants: wardenx_app gets SELECT/INSERT/UPDATE and DELETE on NOTHING. `triage_call_answer` and
--    `triage_call_state_history` get SELECT/INSERT ONLY — both are append-only by §2.2.3/§3.3, a correction
--    is a new row, and withholding UPDATE makes that a permission error rather than a code-review
--    convention. Destruction runs through the admin-role eraseFn (§3.7 / the M21 posture), which is why the
--    app role never gets DELETE anywhere in M19. wardenx_admin keeps ALL everywhere.
--
-- 2. M4 write-audit triggers (§3.6). Every M19 table stamps retention_class 'compliance', matching
--    `M19_AUDIT_RETENTION_CLASS` in @chartwarden/types. That uniformity is the considered answer, not a
--    default: the call tables ARE the clinical record (CoP 418.104); `on_call_shift` is the CoP
--    418.100(c)(2) proof that a nurse was reachable at 2 a.m.; `tenant_oncall_policy` and the protocol pair
--    hold the D7 mandatory-escalation floor, so an edit to them is exactly what a suppression investigation
--    reads; `external_triage_vendor` carries the BAA attestation; and the BCP worklist is the DR-013/066
--    evidence that the paper-origin calls were reconciled — its 72-hour operational LIFETIME says nothing
--    about how long the audit of it must live.
--
--    Denylists mirror `M19_AUDIT_DENYLIST` (@chartwarden/types) VERBATIM so the code-side export view and the
--    DB-side scrub cannot drift:
--      triage_call             caller_phone_e164 / caller_quote_cipher / transcript_cipher / chief_complaint_text
--      triage_call_answer      answer_value_text
--      triage_escalation       trigger_detail / resolution
--      on_call_shift           cancellation_reason / compensation_metadata
--      (everything else        structural only — empty denylist)
--
--    `triage_call_answer.answer_value_text` is denylisted UNCONDITIONALLY where §3.6 qualifies it "when the
--    parent question has answer_type='free_text'". A trigger fires on the answer row and has no cheap,
--    non-racing way to read the parent question mid-write — and the conditional would fail OPEN, capturing
--    free-text cleartext whenever the lookup could not be resolved. The typed answers stay reconstructible
--    from answer_value_int / answer_value_bool, neither denylisted.
--
--    `red_flag_hit` is deliberately NOT denylisted: it is the D5 tamper-evidence that the SERVER evaluated
--    the flag, and scrubbing it would erase the only record a mandatory-escalation-suppression
--    investigation reads. Same argument as M21's controlled-substance quantities.
--
--    The floor-plus-overlay tables COALESCE the audit row's organization_id to app.org_id: the
--    platform-floor row's organization_id is NULL by design, and an audit row with no tenant attribution at
--    all would be unattributable in the §164.528 accounting (the M21 comfort_kit_template precedent).
--
-- 3. The §2.3 forward-transition guard — `m19_enforce_triage_call_forward_state()`. §2.3 asks for this at
--    "infra (CHECK trigger)" level: reverse transitions blocked at the DB, except
--    `awaiting_callback → protocol_in_progress`. It is a trigger and not a CHECK because a CHECK sees only
--    the new row and cannot know what the state WAS. It encodes §2.2.1's transition table as an explicit
--    WHITELIST rather than a rank ordering, because two legal transitions run "backwards" by any ordering —
--    the awaiting-callback resume and `escalated_unresolved → documented_pending_encounter` — and a rank
--    comparison would silently forbid the second. Terminal states (`closed`, `abandoned`) have no outgoing
--    transitions at all.
-- 1. RLS policies + grants (§3.5).--> statement-breakpoint
ALTER TABLE "tenant_oncall_policy" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_oncall_policy_org" ON "tenant_oncall_policy";
CREATE POLICY "tenant_oncall_policy_org" ON "tenant_oncall_policy"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "tenant_oncall_policy" TO wardenx_app;
GRANT ALL ON "tenant_oncall_policy" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "external_triage_vendor" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "external_triage_vendor_org" ON "external_triage_vendor";
CREATE POLICY "external_triage_vendor_org" ON "external_triage_vendor"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "external_triage_vendor" TO wardenx_app;
GRANT ALL ON "external_triage_vendor" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "on_call_shift" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "on_call_shift_org" ON "on_call_shift";
CREATE POLICY "on_call_shift_org" ON "on_call_shift"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "on_call_shift" TO wardenx_app;
GRANT ALL ON "on_call_shift" TO wardenx_admin;--> statement-breakpoint
-- Floor-plus-overlay (D4): read the platform floor, write only your own unlocked rows.--> statement-breakpoint
ALTER TABLE "triage_protocol" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "triage_protocol_read" ON "triage_protocol";
DROP POLICY IF EXISTS "triage_protocol_insert" ON "triage_protocol";
DROP POLICY IF EXISTS "triage_protocol_update" ON "triage_protocol";
CREATE POLICY "triage_protocol_read" ON "triage_protocol"
  FOR SELECT TO wardenx_app
  USING (is_system_locked = true OR organization_id = current_setting('app.org_id', true)::uuid);
CREATE POLICY "triage_protocol_insert" ON "triage_protocol"
  FOR INSERT TO wardenx_app
  WITH CHECK (
    is_system_locked = false
    AND organization_id = current_setting('app.org_id', true)::uuid
  );
CREATE POLICY "triage_protocol_update" ON "triage_protocol"
  FOR UPDATE TO wardenx_app
  USING (
    organization_id = current_setting('app.org_id', true)::uuid
    AND is_system_locked = false
  )
  WITH CHECK (
    organization_id = current_setting('app.org_id', true)::uuid
    AND is_system_locked = false
  );
GRANT SELECT, INSERT, UPDATE ON "triage_protocol" TO wardenx_app;
GRANT ALL ON "triage_protocol" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "triage_protocol_question" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "triage_protocol_question_read" ON "triage_protocol_question";
DROP POLICY IF EXISTS "triage_protocol_question_insert" ON "triage_protocol_question";
DROP POLICY IF EXISTS "triage_protocol_question_update" ON "triage_protocol_question";
CREATE POLICY "triage_protocol_question_read" ON "triage_protocol_question"
  FOR SELECT TO wardenx_app
  USING (is_system_locked = true OR organization_id = current_setting('app.org_id', true)::uuid);
CREATE POLICY "triage_protocol_question_insert" ON "triage_protocol_question"
  FOR INSERT TO wardenx_app
  WITH CHECK (
    is_system_locked = false
    AND organization_id = current_setting('app.org_id', true)::uuid
  );
CREATE POLICY "triage_protocol_question_update" ON "triage_protocol_question"
  FOR UPDATE TO wardenx_app
  USING (
    organization_id = current_setting('app.org_id', true)::uuid
    AND is_system_locked = false
  )
  WITH CHECK (
    organization_id = current_setting('app.org_id', true)::uuid
    AND is_system_locked = false
  );
GRANT SELECT, INSERT, UPDATE ON "triage_protocol_question" TO wardenx_app;
GRANT ALL ON "triage_protocol_question" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "triage_call" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "triage_call_org" ON "triage_call";
CREATE POLICY "triage_call_org" ON "triage_call"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "triage_call" TO wardenx_app;
GRANT ALL ON "triage_call" TO wardenx_admin;--> statement-breakpoint
-- Append-only (§2.2.3): a corrected answer is a NEW row carrying correction_of_answer_id.--> statement-breakpoint
ALTER TABLE "triage_call_answer" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "triage_call_answer_org" ON "triage_call_answer";
CREATE POLICY "triage_call_answer_org" ON "triage_call_answer"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT ON "triage_call_answer" TO wardenx_app;
GRANT ALL ON "triage_call_answer" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "triage_escalation" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "triage_escalation_org" ON "triage_escalation";
CREATE POLICY "triage_escalation_org" ON "triage_escalation"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "triage_escalation" TO wardenx_app;
GRANT ALL ON "triage_escalation" TO wardenx_admin;--> statement-breakpoint
-- Append-only: the transition ledger §2.7 reads the outage window out of.--> statement-breakpoint
ALTER TABLE "triage_call_state_history" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "triage_call_state_history_org" ON "triage_call_state_history";
CREATE POLICY "triage_call_state_history_org" ON "triage_call_state_history"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT ON "triage_call_state_history" TO wardenx_app;
GRANT ALL ON "triage_call_state_history" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "triage_paper_reentry_worklist" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "triage_paper_reentry_worklist_org" ON "triage_paper_reentry_worklist";
CREATE POLICY "triage_paper_reentry_worklist_org" ON "triage_paper_reentry_worklist"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "triage_paper_reentry_worklist" TO wardenx_app;
GRANT ALL ON "triage_paper_reentry_worklist" TO wardenx_admin;--> statement-breakpoint

-- 2. M4 write-audit triggers (§3.6) — one generated function per table, denylists per M19_AUDIT_DENYLIST.--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_tenant_oncall_policy() RETURNS trigger
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
    'tenant_oncall_policy.' || lower(TG_OP),
    'tenant_oncall_policy',
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
ALTER FUNCTION audit_phi_write_tenant_oncall_policy() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_tenant_oncall_policy" AFTER INSERT OR UPDATE OR DELETE ON tenant_oncall_policy
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_tenant_oncall_policy();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_external_triage_vendor() RETURNS trigger
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
    'external_triage_vendor.' || lower(TG_OP),
    'external_triage_vendor',
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
ALTER FUNCTION audit_phi_write_external_triage_vendor() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_external_triage_vendor" AFTER INSERT OR UPDATE OR DELETE ON external_triage_vendor
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_external_triage_vendor();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_on_call_shift() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
  v_cols text[] := ARRAY['cancellation_reason','compensation_metadata']::text[];
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
    'on_call_shift.' || lower(TG_OP),
    'on_call_shift',
    COALESCE(NEW.id, OLD.id),
    COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'),
    'success', 'info', v_before, v_after,
    jsonb_build_object(
      'provider_entity_id', COALESCE(NEW.provider_entity_id, OLD.provider_entity_id),
      'location_id', NULLIF(current_setting('app.location_id', true), '')),
    'compliance'
  );
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_on_call_shift() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_on_call_shift" AFTER INSERT OR UPDATE OR DELETE ON on_call_shift
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_on_call_shift();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_triage_protocol() RETURNS trigger
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
    COALESCE(NEW.organization_id, OLD.organization_id,
             NULLIF(current_setting('app.org_id', true), '')::uuid),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'triage_protocol.' || lower(TG_OP),
    'triage_protocol',
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
ALTER FUNCTION audit_phi_write_triage_protocol() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_triage_protocol" AFTER INSERT OR UPDATE OR DELETE ON triage_protocol
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_triage_protocol();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_triage_protocol_question() RETURNS trigger
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
    COALESCE(NEW.organization_id, OLD.organization_id,
             NULLIF(current_setting('app.org_id', true), '')::uuid),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'triage_protocol_question.' || lower(TG_OP),
    'triage_protocol_question',
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
ALTER FUNCTION audit_phi_write_triage_protocol_question() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_triage_protocol_question" AFTER INSERT OR UPDATE OR DELETE ON triage_protocol_question
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_triage_protocol_question();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_triage_call() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
  v_cols text[] := ARRAY['caller_phone_e164','caller_quote_cipher','transcript_cipher','chief_complaint_text']::text[];
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
    'triage_call.' || lower(TG_OP),
    'triage_call',
    COALESCE(NEW.id, OLD.id),
    COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'),
    'success', 'info', v_before, v_after,
    jsonb_build_object(
      'provider_entity_id', COALESCE(NEW.provider_entity_id, OLD.provider_entity_id),
      'location_id', COALESCE(NEW.location_id, OLD.location_id)),
    'compliance'
  );
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_triage_call() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_triage_call" AFTER INSERT OR UPDATE OR DELETE ON triage_call
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_triage_call();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_triage_call_answer() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
  v_cols text[] := ARRAY['answer_value_text']::text[];
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
    'triage_call_answer.' || lower(TG_OP),
    'triage_call_answer',
    COALESCE(NEW.id, OLD.id),
    COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'),
    'success', 'info', v_before, v_after,
    jsonb_build_object(
      'provider_entity_id', COALESCE(NEW.provider_entity_id, OLD.provider_entity_id),
      'location_id', COALESCE(NEW.location_id, OLD.location_id)),
    'compliance'
  );
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_triage_call_answer() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_triage_call_answer" AFTER INSERT OR UPDATE OR DELETE ON triage_call_answer
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_triage_call_answer();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_triage_escalation() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
  v_cols text[] := ARRAY['trigger_detail','resolution']::text[];
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
    'triage_escalation.' || lower(TG_OP),
    'triage_escalation',
    COALESCE(NEW.id, OLD.id),
    COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'),
    'success', 'info', v_before, v_after,
    jsonb_build_object(
      'provider_entity_id', COALESCE(NEW.provider_entity_id, OLD.provider_entity_id),
      'location_id', COALESCE(NEW.location_id, OLD.location_id)),
    'compliance'
  );
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_triage_escalation() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_triage_escalation" AFTER INSERT OR UPDATE OR DELETE ON triage_escalation
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_triage_escalation();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_triage_call_state_history() RETURNS trigger
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
    'triage_call_state_history.' || lower(TG_OP),
    'triage_call_state_history',
    COALESCE(NEW.id, OLD.id),
    COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'),
    'success', 'info', v_before, v_after,
    jsonb_build_object(
      'provider_entity_id', COALESCE(NEW.provider_entity_id, OLD.provider_entity_id),
      'location_id', COALESCE(NEW.location_id, OLD.location_id)),
    'compliance'
  );
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_triage_call_state_history() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_triage_call_state_history" AFTER INSERT OR UPDATE OR DELETE ON triage_call_state_history
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_triage_call_state_history();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_triage_paper_reentry() RETURNS trigger
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
    'triage_paper_reentry_worklist.' || lower(TG_OP),
    'triage_paper_reentry_worklist',
    COALESCE(NEW.id, OLD.id),
    COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'),
    'success', 'info', v_before, v_after,
    jsonb_build_object(
      'provider_entity_id', COALESCE(NEW.provider_entity_id, OLD.provider_entity_id),
      'location_id', COALESCE(NEW.location_id, OLD.location_id)),
    'compliance'
  );
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_triage_paper_reentry() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_triage_paper_reentry_worklist" AFTER INSERT OR UPDATE OR DELETE ON triage_paper_reentry_worklist
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_triage_paper_reentry();--> statement-breakpoint

-- 3. The §2.3 forward-transition guard (§2.2.1's table as a whitelist — see the header).--> statement-breakpoint
CREATE OR REPLACE FUNCTION m19_enforce_triage_call_forward_state() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_allowed text[];
BEGIN
  IF NEW.state IS NOT DISTINCT FROM OLD.state THEN
    RETURN NEW;
  END IF;

  v_allowed := CASE OLD.state::text
    WHEN 'open' THEN ARRAY['protocol_in_progress','abandoned']
    WHEN 'protocol_in_progress' THEN ARRAY['disposition_pending','awaiting_callback','abandoned']
    -- The one documented reverse transition (§2.3): the caller rang back.
    WHEN 'awaiting_callback' THEN ARRAY['protocol_in_progress','abandoned']
    WHEN 'disposition_pending' THEN ARRAY['documented_pending_encounter','escalated_unresolved','abandoned']
    -- Parks here while awaiting m8.encounter.signed; also where §2.7's D-B degraded path strands a call.
    WHEN 'documented_pending_encounter' THEN ARRAY['documented','abandoned']
    WHEN 'escalated_unresolved' THEN ARRAY['documented_pending_encounter','abandoned']
    WHEN 'documented' THEN ARRAY['closed']
    ELSE ARRAY[]::text[]  -- closed / abandoned are terminal
  END;

  IF NOT (NEW.state::text = ANY (v_allowed)) THEN
    RAISE EXCEPTION 'M19_ILLEGAL_TRANSITION: triage_call % cannot move from % to % (§2.2.1)', OLD.id, OLD.state, NEW.state;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_m19_triage_call_forward_state"
BEFORE UPDATE OF state ON triage_call
FOR EACH ROW EXECUTE FUNCTION m19_enforce_triage_call_forward_state();
