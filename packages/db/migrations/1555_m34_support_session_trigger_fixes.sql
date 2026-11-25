-- compat: expand
-- M34: two defects in the support-session triggers that 1487 introduced. CREATE OR REPLACE keeps each function's owner and ACL
-- from 1486/1487, so neither is repeated here.
--
-- 1. The grant_revoked close trigger must not use ON CONFLICT. 1487's m34_record_support_session_close() ran
--    `INSERT ... ON CONFLICT ... DO NOTHING` as chartwarden_admin. Postgres applies a table's SELECT policies to an INSERT that
--    carries an ON CONFLICT clause, and chartwarden_admin has no SELECT policy on support_session_event (only chartwarden_app reads
--    it), so every grant_revoked close failed with "new row violates row-level security policy" and aborted the revoke that caused
--    it. The clause never did anything: this trigger is the only writer of a grant_revoked close row, it fires once per session
--    (closed_at is immutable after the first close), and the app writes no ledger row for that reason. Dropping the clause, rather
--    than giving the trigger owner a SELECT policy, keeps chartwarden_admin write-only on the ledger. A second row would trip the
--    one-close index and abort the close, which is the fail-closed outcome for an evidence table.
--
-- 2. The two audit triggers must not resolve audit_event through the caller's temp schema. 1486 had `search_path = pg_catalog,
--    pg_temp` and schema-qualified names; 1487 rewrote them with `pg_catalog, public` and unqualified `audit_event` / `audit_scrub`.
--    A search_path that does not name pg_temp is searched with the session's temp schema FIRST, so the tenant role (it may create
--    temp tables) could CREATE TEMP TABLE audit_event and have the support-session audit rows written there instead of the audit
--    log. Back to 1486's form, keeping 1487's scrubbing and anonymous 'system' attribution.
CREATE OR REPLACE FUNCTION m34_record_support_session_close() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  INSERT INTO public.support_session_event (
    organization_id, support_session_id, event_kind, occurred_at, actor_ip, context
  ) VALUES (
    NEW.organization_id, NEW.id, 'session.close', NEW.closed_at, NULL,
    jsonb_build_object('closeReason', 'grant_revoked')
  );
  RETURN NEW;
END $$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_support_session() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE v_before jsonb; v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN public.audit_scrub(to_jsonb(OLD), ARRAY['actor_membership_id']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN public.audit_scrub(to_jsonb(NEW), ARRAY['actor_membership_id']::text[]) ELSE NULL END;
  INSERT INTO public.audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after, context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id), NULL, 'system',
    'support_session.' || lower(TG_OP), 'support_session', COALESCE(NEW.id, OLD.id),
    COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'),
    'success', 'info', v_before, v_after, '{}'::jsonb, 'compliance'
  );
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_support_session_event() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE v_before jsonb; v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN public.audit_scrub(to_jsonb(OLD), ARRAY['actor_ip','context']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN public.audit_scrub(to_jsonb(NEW), ARRAY['actor_ip','context']::text[]) ELSE NULL END;
  INSERT INTO public.audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after, context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id), NULL, 'system',
    'support_session_event.' || lower(TG_OP), 'support_session_event', COALESCE(NEW.id, OLD.id),
    COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'),
    'success', 'info', v_before, v_after,
    jsonb_build_object('patient_id', COALESCE(NEW.patient_id, OLD.patient_id)), 'compliance'
  );
  RETURN COALESCE(NEW, OLD);
END $$;
