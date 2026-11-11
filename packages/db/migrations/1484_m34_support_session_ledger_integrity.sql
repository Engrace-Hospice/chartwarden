-- compat: contract
-- M34 slice 7: make the tenant-readable support-session ledger trustworthy and anonymous at the database boundary.

ALTER TABLE support_consent_grant
  ADD CONSTRAINT support_consent_grant_id_org_uq UNIQUE (id, organization_id);--> statement-breakpoint
ALTER TABLE support_session
  ADD CONSTRAINT support_session_id_org_uq UNIQUE (id, organization_id);--> statement-breakpoint
ALTER TABLE support_session
  ADD CONSTRAINT support_session_grant_org_fk
  FOREIGN KEY (support_consent_grant_id, organization_id)
  REFERENCES support_consent_grant (id, organization_id) NOT VALID;--> statement-breakpoint
ALTER TABLE support_session_event
  ADD CONSTRAINT support_session_event_session_org_fk
  FOREIGN KEY (support_session_id, organization_id)
  REFERENCES support_session (id, organization_id) NOT VALID;--> statement-breakpoint
ALTER TABLE support_session VALIDATE CONSTRAINT support_session_grant_org_fk;--> statement-breakpoint
ALTER TABLE support_session_event VALIDATE CONSTRAINT support_session_event_session_org_fk;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM support_session_event
    WHERE event_kind = 'session.close'
    GROUP BY organization_id, support_session_id, event_kind
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'duplicate support-session close ledger rows require reviewed remediation before migration 1484';
  END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX support_session_event_one_close_uq
  ON support_session_event (organization_id, support_session_id, event_kind)
  WHERE event_kind = 'session.close';--> statement-breakpoint
CREATE OR REPLACE FUNCTION m34_guard_support_grant_revoke() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.revoked_at IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'a revoked support consent grant is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL THEN
    IF NEW.expires_at IS DISTINCT FROM OLD.expires_at
       OR NEW.issued_at IS DISTINCT FROM OLD.issued_at
       OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
       OR NEW.tenant_account_id IS DISTINCT FROM OLD.tenant_account_id
       OR NEW.scope IS DISTINCT FROM OLD.scope
       OR NEW.patient_ids_in_scope IS DISTINCT FROM OLD.patient_ids_in_scope
       OR NEW.grant_reason IS DISTINCT FROM OLD.grant_reason
       OR NEW.grantor_membership_id IS DISTINCT FROM OLD.grantor_membership_id THEN
      RAISE EXCEPTION 'revoking a support consent grant may change only revoke fields' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_m34_guard_support_grant_revoke ON support_consent_grant;--> statement-breakpoint
CREATE TRIGGER trg_m34_guard_support_grant_revoke
  BEFORE UPDATE ON support_consent_grant
  FOR EACH ROW EXECUTE FUNCTION m34_guard_support_grant_revoke();--> statement-breakpoint

CREATE OR REPLACE FUNCTION m34_guard_support_session_close() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.closed_at IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'a closed support session is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.closed_at IS NULL AND NEW.closed_at IS NOT NULL THEN
    IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
       OR NEW.support_consent_grant_id IS DISTINCT FROM OLD.support_consent_grant_id
       OR NEW.actor_membership_id IS DISTINCT FROM OLD.actor_membership_id
       OR NEW.started_at IS DISTINCT FROM OLD.started_at
       OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
      RAISE EXCEPTION 'closing a support session may change only close fields' USING ERRCODE = '23514';
    END IF;
    IF NEW.close_reason = 'grant_revoked' AND NOT EXISTS (
      SELECT 1 FROM support_consent_grant g
      WHERE g.id = NEW.support_consent_grant_id
        AND g.organization_id = NEW.organization_id
        AND g.revoked_at IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'grant_revoked close requires a revoked support consent grant' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_m34_guard_support_session_close ON support_session;--> statement-breakpoint
CREATE TRIGGER trg_m34_guard_support_session_close
  BEFORE UPDATE ON support_session
  FOR EACH ROW EXECUTE FUNCTION m34_guard_support_session_close();--> statement-breakpoint

-- A grant-revoke close is written by the tenant role. The ledger row is therefore trigger-owned; the role cannot forge one.
CREATE OR REPLACE FUNCTION m34_record_grant_revoke_close() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.closed_at IS NULL AND NEW.closed_at IS NOT NULL AND NEW.close_reason = 'grant_revoked' THEN
    INSERT INTO support_session_event (
      organization_id, support_session_id, event_kind, occurred_at, actor_ip, context
    ) VALUES (
      NEW.organization_id, NEW.id, 'session.close', NEW.closed_at, NULL,
      jsonb_build_object('closeReason', 'grant_revoked')
    ) ON CONFLICT (organization_id, support_session_id, event_kind)
      WHERE event_kind = 'session.close' DO NOTHING;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
ALTER FUNCTION m34_record_grant_revoke_close() OWNER TO chartwarden_admin;--> statement-breakpoint
REVOKE ALL ON FUNCTION m34_record_grant_revoke_close() FROM PUBLIC;--> statement-breakpoint
GRANT INSERT ON support_session_event TO chartwarden_admin;--> statement-breakpoint
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
DROP TRIGGER IF EXISTS trg_m34_record_grant_revoke_close ON support_session;--> statement-breakpoint
CREATE TRIGGER trg_m34_record_grant_revoke_close
  AFTER UPDATE ON support_session
  FOR EACH ROW EXECUTE FUNCTION m34_record_grant_revoke_close();--> statement-breakpoint

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
