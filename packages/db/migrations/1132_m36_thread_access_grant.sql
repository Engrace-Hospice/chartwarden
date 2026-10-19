-- M36 ADR-0083 (PROPOSED), slice G1 - the audited, time-limited, one-thread read grant. Schema and guards only: NOTHING writes or reads this
-- table until slice G2, and the tenant flag messaging.thread_access_grant (absent = off) gates that wiring.
--   * A grant lets ONE user read ONE thread (a root message and its replies) of a request they cannot otherwise view. Ids, a closed
--     reason and instants only: no text, no patient column (the patient is reached through the request).
--   * Expiry is the DATABASE clock: granted_at is forced to now() on insert and revoked_at to now() on revoke, and every check compares to
--     now() in SQL (never an application clock). expires_at > granted_at is a CHECK.
--   * Insert / revoke-only: the one permitted update moves revoked_at from NULL to a value, once; the app role holds no DELETE and an
--     UPDATE grant on revoked_at alone (the trigger is the backstop for any other role). One LIVE grant per (request, grantee).
CREATE TABLE "message_thread_access_grant" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "channel_id" uuid NOT NULL,
  "root_message_id" uuid NOT NULL,
  "request_id" uuid NOT NULL,
  "grantee_user_id" uuid NOT NULL REFERENCES "user"("id"),
  "reason" text NOT NULL,
  "granted_at" timestamptz DEFAULT now() NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "revoked_at" timestamptz,
  CONSTRAINT "message_thread_grant_reason" CHECK ("reason" IN ('escalated', 'reassigned', 'oncall_role_send')),
  CONSTRAINT "message_thread_grant_window" CHECK ("expires_at" > "granted_at"),
  CONSTRAINT "message_thread_grant_root_fk"
    FOREIGN KEY ("organization_id", "channel_id", "root_message_id")
    REFERENCES "message"("organization_id", "channel_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "message_thread_grant_request_fk"
    FOREIGN KEY ("organization_id", "request_id")
    REFERENCES "message_acknowledgment_request"("organization_id", "id") ON DELETE RESTRICT
);--> statement-breakpoint
CREATE UNIQUE INDEX "message_thread_grant_one_live"
  ON "message_thread_access_grant" ("organization_id", "request_id", "grantee_user_id") WHERE "revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "message_thread_grant_root_idx"
  ON "message_thread_access_grant" ("organization_id", "channel_id", "root_message_id");--> statement-breakpoint
CREATE INDEX "message_thread_grant_grantee_idx"
  ON "message_thread_access_grant" ("organization_id", "grantee_user_id", "expires_at");--> statement-breakpoint
CREATE INDEX "message_thread_grant_grantee_user_idx" ON "message_thread_access_grant" ("grantee_user_id");--> statement-breakpoint

CREATE OR REPLACE FUNCTION message_thread_grant_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.granted_at := now();
    NEW.revoked_at := NULL;
    RETURN NEW;
  END IF;
  IF OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'message_thread_grant_revoked: a revoked grant cannot be changed' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.revoked_at IS NULL OR (to_jsonb(NEW) - 'revoked_at') IS DISTINCT FROM (to_jsonb(OLD) - 'revoked_at') THEN
    RAISE EXCEPTION 'message_thread_grant_immutable: the only change allowed is revoking the grant' USING ERRCODE = 'check_violation';
  END IF;
  NEW.revoked_at := now();
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_message_thread_grant_guard"
  BEFORE INSERT OR UPDATE ON "message_thread_access_grant"
  FOR EACH ROW EXECUTE FUNCTION message_thread_grant_guard();--> statement-breakpoint

ALTER TABLE "message_thread_access_grant" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "message_thread_access_grant" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "message_thread_grant_org_isolation" ON "message_thread_access_grant"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT ON "message_thread_access_grant" TO wardenx_app;--> statement-breakpoint
GRANT UPDATE ("revoked_at") ON "message_thread_access_grant" TO wardenx_app;--> statement-breakpoint

-- The 1107 PHI audit pattern. The table carries no patient column, so the scrub list is empty; the grant, its revoke and (via the read
-- route, G2) each read are the audit shape.
CREATE OR REPLACE FUNCTION audit_phi_write_message_thread_access_grant() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_before jsonb; v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN public.audit_scrub(to_jsonb(OLD), ARRAY[]::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN public.audit_scrub(to_jsonb(NEW), ARRAY[]::text[]) ELSE NULL END;
  INSERT INTO public.audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id,
    correlation_id, outcome, severity, before, after, context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    CASE WHEN COALESCE(current_setting('app.user_id', true), '') = '' THEN 'system' ELSE 'user' END::audit_actor_kind,
    'message_thread_access_grant.' || lower(TG_OP), 'message_thread_access_grant',
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
ALTER FUNCTION audit_phi_write_message_thread_access_grant() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_message_thread_access_grant"
  AFTER INSERT OR UPDATE OR DELETE ON message_thread_access_grant
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_message_thread_access_grant();--> statement-breakpoint

GRANT SELECT, DELETE ON "message_thread_access_grant" TO wardenx_destruction;--> statement-breakpoint
CREATE POLICY "message_thread_grant_destruction" ON "message_thread_access_grant"
  FOR ALL TO wardenx_destruction
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
