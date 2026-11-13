-- compat: contract
-- M34 slice 7: make the tenant-readable support-session ledger trustworthy and anonymous at the database boundary.

-- 1486 already owns the grant/session composite FK and the one-close index. The ledger deliberately
-- has no SQL FK to support_session: offboarding erases session headers but retains this §164.528
-- evidence. Enforce the same-tenant parent on child INSERT/UPDATE only, leaving parent DELETE alone.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM support_session_event e
      JOIN support_session s ON s.id = e.support_session_id
     WHERE s.organization_id <> e.organization_id
  ) THEN
    RAISE EXCEPTION 'cross-tenant support-session ledger rows require reviewed remediation before migration 1487';
  END IF;
END $$;--> statement-breakpoint

-- The trigger owner is NOLOGIN/NOBYPASSRLS. Its historical admin grant still needs an explicit
-- forced-RLS lane; the column grant documents the two fields this parent check depends on.
GRANT SELECT (id, organization_id) ON support_session TO chartwarden_admin;--> statement-breakpoint
DROP POLICY IF EXISTS support_session_admin_event_parent_check ON support_session;--> statement-breakpoint
CREATE POLICY support_session_admin_event_parent_check ON support_session
  FOR SELECT TO chartwarden_admin USING (true);--> statement-breakpoint

CREATE OR REPLACE FUNCTION m34_guard_support_session_event_parent() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.support_session s
     WHERE s.id = NEW.support_session_id
       AND s.organization_id = NEW.organization_id
  ) THEN
    RAISE EXCEPTION 'support-session ledger parent is missing or belongs to another organization'
      USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
ALTER FUNCTION m34_guard_support_session_event_parent() OWNER TO chartwarden_admin;--> statement-breakpoint
REVOKE ALL ON FUNCTION m34_guard_support_session_event_parent() FROM PUBLIC;--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_m34_guard_support_session_event_parent ON support_session_event;--> statement-breakpoint
CREATE TRIGGER trg_m34_guard_support_session_event_parent
  BEFORE INSERT OR UPDATE OF organization_id, support_session_id ON support_session_event
  FOR EACH ROW EXECUTE FUNCTION m34_guard_support_session_event_parent();--> statement-breakpoint

-- Preserve every close invariant introduced by 1486 and add the tenant-revoke proof: a
-- grant_revoked close is accepted only after that same organization's grant is revoked.
CREATE OR REPLACE FUNCTION m34_guard_support_session_close() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.closed_at IS NOT NULL THEN
    RAISE EXCEPTION 'a closed support session is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.support_consent_grant_id IS DISTINCT FROM OLD.support_consent_grant_id
     OR NEW.actor_membership_id IS DISTINCT FROM OLD.actor_membership_id
     OR NEW.started_at IS DISTINCT FROM OLD.started_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.closed_at IS NULL
     OR NEW.close_reason NOT IN ('manual', 'expired', 'grant_revoked', 'forced_terminated')
     OR NEW.closed_at < OLD.started_at
     OR NEW.closed_at > OLD.expires_at + interval '24 hours' THEN
    RAISE EXCEPTION 'invalid support session close transition' USING ERRCODE = '23514';
  END IF;
  IF NEW.close_reason = 'grant_revoked' AND NOT EXISTS (
    SELECT 1 FROM support_consent_grant g
     WHERE g.id = NEW.support_consent_grant_id
       AND g.organization_id = NEW.organization_id
       AND g.revoked_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'grant_revoked close requires a revoked support consent grant' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_m34_guard_support_session_close ON support_session;--> statement-breakpoint
CREATE TRIGGER trg_m34_guard_support_session_close
  BEFORE UPDATE ON support_session
  FOR EACH ROW EXECUTE FUNCTION m34_guard_support_session_close();--> statement-breakpoint

-- Replace 1486's canonical trigger in place. A second AFTER UPDATE trigger would double-insert and
-- abort the revoke on the one-close index. The row is trigger-owned; the tenant role cannot forge it.
DROP TRIGGER IF EXISTS trg_m34_record_support_session_close ON support_session;--> statement-breakpoint
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
  ) ON CONFLICT (organization_id, support_session_id)
    WHERE event_kind = 'session.close' DO NOTHING;
  RETURN NEW;
END $$;--> statement-breakpoint
ALTER FUNCTION m34_record_support_session_close() OWNER TO chartwarden_admin;--> statement-breakpoint
REVOKE ALL ON FUNCTION m34_record_support_session_close() FROM PUBLIC;--> statement-breakpoint
GRANT INSERT ON support_session_event TO chartwarden_admin;--> statement-breakpoint
GRANT INSERT ON support_session_event_default TO chartwarden_admin;--> statement-breakpoint
DROP POLICY IF EXISTS support_session_event_admin_grant_revoke_close ON support_session_event;--> statement-breakpoint
CREATE POLICY support_session_event_admin_grant_revoke_close ON support_session_event
  FOR INSERT TO chartwarden_admin
  WITH CHECK (
    event_kind = 'session.close'
    AND actor_ip IS NULL
    AND patient_id IS NULL
    AND resource_kind IS NULL
    AND resource_id IS NULL
    AND context = '{"closeReason":"grant_revoked"}'::jsonb
  );--> statement-breakpoint
CREATE TRIGGER trg_m34_record_support_session_close
  AFTER UPDATE ON support_session
  FOR EACH ROW WHEN (
    OLD.closed_at IS NULL
    AND NEW.closed_at IS NOT NULL
    AND NEW.close_reason = 'grant_revoked'
  ) EXECUTE FUNCTION m34_record_support_session_close();--> statement-breakpoint

DROP POLICY IF EXISTS support_session_event_org_close ON support_session_event;--> statement-breakpoint
REVOKE INSERT ON support_session_event FROM chartwarden_app;--> statement-breakpoint

DROP POLICY IF EXISTS support_grant_org_issue ON support_consent_grant;--> statement-breakpoint
CREATE POLICY support_grant_org_issue ON support_consent_grant
  FOR INSERT TO chartwarden_app
  WITH CHECK (
    organization_id = nullif(current_setting('app.org_id', true), '')::uuid
    AND revoked_at IS NULL AND revoked_by_membership_id IS NULL AND revocation_reason IS NULL
    AND issued_at BETWEEN clock_timestamp() - interval '5 minutes' AND clock_timestamp() + interval '5 minutes'
    AND expires_at > issued_at AND expires_at <= issued_at + interval '72 hours'
  );--> statement-breakpoint

-- Audit rows are tenant-readable. Never copy the platform operator's membership, address or arbitrary event context into them.
CREATE OR REPLACE FUNCTION audit_phi_write_support_session() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE v_before jsonb; v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['actor_membership_id']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['actor_membership_id']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
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
ALTER FUNCTION audit_phi_write_support_session() OWNER TO chartwarden_audit_writer;--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_support_session_event() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE v_before jsonb; v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['actor_ip','context']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['actor_ip','context']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
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
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_support_session_event() OWNER TO chartwarden_audit_writer;
