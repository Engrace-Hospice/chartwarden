-- M36 WP 5.6 (ADR-0055 item 7 / ADR-0086, PROPOSED) - redaction of a message: a two-person, audited act that MASKS a message for every reader.
--   * message_redaction: one row per message (UNIQUE). A request names the message, the requester and a 10..1000 character reason; an
--     approval stamps approved_by / approved_at. The approver is never the requester (CHECK, and the guard binds both people to
--     app.user_id, so the rule holds in the database even if a caller passes another user's id). The only UPDATE permitted moves
--     (approved_by, approved_at) from NULL to a value, once; both instants come from the DATABASE clock.
--   * A redaction NEVER touches the message: not its cipher, not its hash, not its status. ADR-0055 item 8: physical destruction stays on
--     the retention path. So it is neither blocked by an active legal hold nor does it weaken one (the 1138 guard fires on body_cipher
--     writes only), and the held cipher stays retained under the mask. The mask is applied where a body is read (the service layer).
--   * Row-level security on app.org_id (FORCEd); the app role holds SELECT, INSERT and UPDATE on the two approval columns, and no DELETE
--     (only chartwarden_destruction deletes, and the FK to message CASCADEs so the retention executor and the tenant eraser take it with
--     the message). The reason is free text: it is left out of the audit row (ids, people and instants stay).
--   * Every guard is SECURITY INVOKER: its reads run under the caller's own org RLS.
CREATE TABLE "message_redaction" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "message_id" uuid NOT NULL,
  "requested_by" uuid NOT NULL REFERENCES "user"("id"),
  "reason" text NOT NULL,
  "requested_at" timestamptz DEFAULT now() NOT NULL,
  "approved_by" uuid REFERENCES "user"("id"),
  "approved_at" timestamptz,
  CONSTRAINT "message_redaction_message_fk"
    FOREIGN KEY ("organization_id", "message_id")
    REFERENCES "message"("organization_id", "id") ON DELETE CASCADE,
  CONSTRAINT "message_redaction_one_per_message" UNIQUE ("organization_id", "message_id"),
  CONSTRAINT "message_redaction_reason_len" CHECK (char_length(btrim("reason")) BETWEEN 10 AND 1000),
  CONSTRAINT "message_redaction_approval_pair" CHECK (("approved_by" IS NULL) = ("approved_at" IS NULL)),
  CONSTRAINT "message_redaction_two_people" CHECK ("approved_by" IS NULL OR "approved_by" <> "requested_by")
);--> statement-breakpoint
CREATE INDEX "message_redaction_requested_by_idx" ON "message_redaction" ("requested_by");--> statement-breakpoint
CREATE INDEX "message_redaction_approved_by_idx" ON "message_redaction" ("approved_by") WHERE "approved_by" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "message_redaction_org_requested_idx" ON "message_redaction" ("organization_id", "requested_at");--> statement-breakpoint

CREATE OR REPLACE FUNCTION message_redaction_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.requested_by IS DISTINCT FROM nullif(current_setting('app.user_id', true), '')::uuid THEN
      RAISE EXCEPTION 'message_redaction_actor: a request is recorded only by its own requester' USING ERRCODE = 'check_violation';
    END IF;
    NEW.requested_at := now();
    NEW.approved_by := NULL;
    NEW.approved_at := NULL;
    RETURN NEW;
  END IF;
  IF OLD.approved_at IS NOT NULL THEN
    RAISE EXCEPTION 'message_redaction_final: an approved redaction cannot be changed' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.approved_by IS NULL
     OR (to_jsonb(NEW) - ARRAY['approved_by', 'approved_at']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['approved_by', 'approved_at']) THEN
    RAISE EXCEPTION 'message_redaction_immutable: the only change allowed is the approval' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.approved_by IS DISTINCT FROM nullif(current_setting('app.user_id', true), '')::uuid THEN
    RAISE EXCEPTION 'message_redaction_actor: an approval is recorded only by the approving user' USING ERRCODE = 'check_violation';
  END IF;
  NEW.approved_at := now();
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_message_redaction_guard"
  BEFORE INSERT OR UPDATE ON "message_redaction"
  FOR EACH ROW EXECUTE FUNCTION message_redaction_guard();--> statement-breakpoint

ALTER TABLE "message_redaction" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "message_redaction" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "message_redaction_org_isolation" ON "message_redaction"
  FOR ALL TO chartwarden_app
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT ON "message_redaction" TO chartwarden_app;--> statement-breakpoint
GRANT UPDATE ("approved_by", "approved_at") ON "message_redaction" TO chartwarden_app;--> statement-breakpoint

-- The 1107 PHI audit pattern; the free-text reason is left out of the audit row.
CREATE OR REPLACE FUNCTION audit_phi_write_message_redaction() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_before jsonb; v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN public.audit_scrub(to_jsonb(OLD) - 'reason', ARRAY[]::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN public.audit_scrub(to_jsonb(NEW) - 'reason', ARRAY[]::text[]) ELSE NULL END;
  INSERT INTO public.audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id,
    correlation_id, outcome, severity, before, after, context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    CASE WHEN COALESCE(current_setting('app.user_id', true), '') = '' THEN 'system' ELSE 'user' END::audit_actor_kind,
    'message_redaction.' || lower(TG_OP), 'message_redaction',
    COALESCE(NEW.id, OLD.id),
    COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'),
    'success', 'warn', v_before, v_after,
    jsonb_build_object(
      'provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), ''),
      'location_id', NULLIF(current_setting('app.location_id', true), '')),
    'compliance'
  );
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_message_redaction() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_message_redaction"
  AFTER INSERT OR UPDATE OR DELETE ON message_redaction
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_message_redaction();--> statement-breakpoint

GRANT SELECT, DELETE ON "message_redaction" TO chartwarden_destruction;--> statement-breakpoint
CREATE POLICY "message_redaction_destruction" ON "message_redaction"
  FOR ALL TO chartwarden_destruction
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint

-- The permissions (mirrors 1138 / 1147). Approve also demands a fresh step-up in the route. ADR-0055 D9 (product owner): org admin has NO
-- implicit right to either, so these go to compliance_officer ONLY (and the full-catalog admin roles are told to skip them in code). The
-- single-officer fallback (self-approval plus a countersign) is NOT built: a tenant with one compliance officer cannot redact yet.
INSERT INTO "permission" ("key", "resource", "action", "category", "default_abac", "description") VALUES
  ('messaging.redact.request', 'message_redaction', 'request', 'compliance', 'none', ''),
  ('messaging.redact.approve', 'message_redaction', 'approve', 'compliance', 'none', '')
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
INSERT INTO "role_permission" ("organization_id", "role_id", "permission_key")
SELECT r."organization_id", r."id", 'messaging.redact.request'
  FROM "role" r
 WHERE r."key" = 'compliance_officer'
   AND r."organization_id" IS NOT NULL
ON CONFLICT ("role_id", "permission_key") DO NOTHING;--> statement-breakpoint
INSERT INTO "role_permission" ("organization_id", "role_id", "permission_key")
SELECT r."organization_id", r."id", 'messaging.redact.approve'
  FROM "role" r
 WHERE r."key" = 'compliance_officer'
   AND r."organization_id" IS NOT NULL
ON CONFLICT ("role_id", "permission_key") DO NOTHING;
