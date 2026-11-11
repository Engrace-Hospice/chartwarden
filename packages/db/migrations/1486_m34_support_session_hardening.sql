-- compat: contract
-- M34 slice 7 security hardening: bind sessions to the grant's tenant, make revoke/close transitions
-- immutable, generate grant-revocation close evidence in the database, and keep operator identifiers
-- out of the tenant-visible generic audit stream.

ALTER TABLE "support_consent_grant"
  ADD CONSTRAINT "support_consent_grant_id_org_unique" UNIQUE ("id", "organization_id");--> statement-breakpoint

ALTER TABLE "support_session"
  ADD CONSTRAINT "support_session_grant_org_fk"
  FOREIGN KEY ("support_consent_grant_id", "organization_id")
  REFERENCES "support_consent_grant" ("id", "organization_id")
  ON DELETE RESTRICT;--> statement-breakpoint

CREATE UNIQUE INDEX "support_session_one_open_actor_grant_idx"
  ON "support_session" ("support_consent_grant_id", "actor_membership_id")
  WHERE "closed_at" IS NULL;--> statement-breakpoint

CREATE UNIQUE INDEX "support_session_event_one_close_idx"
  ON "support_session_event" ("organization_id", "support_session_id")
  WHERE "event_kind" = 'session.close';--> statement-breakpoint

CREATE INDEX "support_session_event_org_session_occurred_idx"
  ON "support_session_event" ("organization_id", "support_session_id", "occurred_at" DESC);--> statement-breakpoint

CREATE OR REPLACE FUNCTION m34_guard_support_grant_transition() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'a revoked support consent grant is immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.tenant_account_id IS DISTINCT FROM OLD.tenant_account_id
     OR NEW.scope IS DISTINCT FROM OLD.scope
     OR NEW.patient_ids_in_scope IS DISTINCT FROM OLD.patient_ids_in_scope
     OR NEW.grant_reason IS DISTINCT FROM OLD.grant_reason
     OR NEW.grantor_membership_id IS DISTINCT FROM OLD.grantor_membership_id
     OR NEW.issued_at IS DISTINCT FROM OLD.issued_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'support consent grant envelope is immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.revoked_at IS NULL
     OR NEW.revoked_by_membership_id IS NULL
     OR NEW.revocation_reason IS NULL
     OR NEW.revoked_at < statement_timestamp() - interval '5 minutes'
     OR NEW.revoked_at > statement_timestamp() + interval '5 minutes' THEN
    RAISE EXCEPTION 'support consent grant revocation is incomplete or has an invalid timestamp' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint

CREATE TRIGGER "trg_m34_guard_support_grant_transition"
  BEFORE UPDATE ON "support_consent_grant"
  FOR EACH ROW EXECUTE FUNCTION m34_guard_support_grant_transition();--> statement-breakpoint

CREATE OR REPLACE FUNCTION m34_guard_support_session_insert() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_grant support_consent_grant%ROWTYPE;
BEGIN
  SELECT * INTO v_grant FROM support_consent_grant WHERE id = NEW.support_consent_grant_id;
  IF NOT FOUND
     OR v_grant.organization_id <> NEW.organization_id
     OR v_grant.revoked_at IS NOT NULL
     OR v_grant.expires_at <= statement_timestamp()
     OR NEW.started_at < statement_timestamp() - interval '5 minutes'
     OR NEW.started_at > statement_timestamp() + interval '5 minutes'
     OR NEW.expires_at > v_grant.expires_at
     OR NEW.expires_at > NEW.started_at + interval '8 hours'
     OR NEW.expires_at <= NEW.started_at
     OR NEW.closed_at IS NOT NULL
     OR NEW.close_reason IS NOT NULL THEN
    RAISE EXCEPTION 'invalid support session envelope' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint

CREATE TRIGGER "trg_m34_guard_support_session_insert"
  BEFORE INSERT ON "support_session"
  FOR EACH ROW EXECUTE FUNCTION m34_guard_support_session_insert();--> statement-breakpoint

CREATE OR REPLACE FUNCTION m34_guard_support_session_close() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.closed_at IS NOT NULL THEN
    RAISE EXCEPTION 'a closed support session is immutable' USING ERRCODE = 'check_violation';
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
    RAISE EXCEPTION 'invalid support session close transition' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint

CREATE TRIGGER "trg_m34_guard_support_session_close"
  BEFORE UPDATE ON "support_session"
  FOR EACH ROW EXECUTE FUNCTION m34_guard_support_session_close();--> statement-breakpoint

CREATE OR REPLACE FUNCTION m34_record_support_session_close() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  INSERT INTO support_session_event (
    organization_id, support_session_id, event_kind, occurred_at, context
  ) VALUES (
    NEW.organization_id, NEW.id, 'session.close', NEW.closed_at,
    jsonb_build_object('closeReason', NEW.close_reason)
  ) ON CONFLICT (organization_id, support_session_id) WHERE event_kind = 'session.close' DO NOTHING;
  RETURN NEW;
END $$;--> statement-breakpoint
ALTER FUNCTION m34_record_support_session_close() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
GRANT INSERT ON "support_session_event" TO chartwarden_audit_writer;--> statement-breakpoint
GRANT INSERT ON "support_session_event_default" TO chartwarden_audit_writer;--> statement-breakpoint

CREATE TRIGGER "trg_m34_record_support_session_close"
  AFTER UPDATE ON "support_session"
  FOR EACH ROW WHEN (
    OLD.closed_at IS NULL
    AND NEW.closed_at IS NOT NULL
    AND NEW.close_reason = 'grant_revoked'
  )
  EXECUTE FUNCTION m34_record_support_session_close();--> statement-breakpoint

DROP POLICY IF EXISTS "support_session_event_audit_writer_insert" ON "support_session_event";--> statement-breakpoint
CREATE POLICY "support_session_event_audit_writer_insert" ON "support_session_event"
  FOR INSERT TO chartwarden_audit_writer WITH CHECK (true);--> statement-breakpoint

DROP POLICY IF EXISTS "support_grant_org_issue" ON "support_consent_grant";--> statement-breakpoint
CREATE POLICY "support_grant_org_issue" ON "support_consent_grant"
  FOR INSERT TO chartwarden_app
  WITH CHECK (
    organization_id = nullif(current_setting('app.org_id', true), '')::uuid
    AND revoked_at IS NULL AND revoked_by_membership_id IS NULL AND revocation_reason IS NULL
    AND issued_at BETWEEN statement_timestamp() - interval '5 minutes' AND statement_timestamp() + interval '5 minutes'
    AND expires_at > issued_at
    AND expires_at <= issued_at + interval '72 hours'
  );--> statement-breakpoint

DROP POLICY IF EXISTS "support_session_event_org_close" ON "support_session_event";--> statement-breakpoint
REVOKE INSERT ON "support_session_event" FROM chartwarden_app;--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_support_session() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE v_before jsonb; v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), ARRAY['actor_membership_id']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), ARRAY['actor_membership_id']::text[]) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id,
    correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user', 'support_session.' || lower(TG_OP), 'support_session', COALESCE(NEW.id, OLD.id),
    COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after,
    jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), ''),
      'location_id', NULLIF(current_setting('app.location_id', true), '')), 'compliance');
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
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), ARRAY['actor_ip']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), ARRAY['actor_ip']::text[]) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id,
    correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user', 'support_session_event.' || lower(TG_OP), 'support_session_event', COALESCE(NEW.id, OLD.id),
    COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after,
    jsonb_build_object('patient_id', COALESCE(NEW.patient_id, OLD.patient_id),
      'provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), ''),
      'location_id', NULLIF(current_setting('app.location_id', true), '')), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_support_session_event() OWNER TO chartwarden_audit_writer;
