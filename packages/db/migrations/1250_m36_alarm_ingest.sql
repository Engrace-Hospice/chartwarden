-- M36 WP 6.10 (ADR-0101, PROPOSED) - alarm ingest, WATCH ONLY. A third-party alarm becomes an ordinary M36 alert, nothing more: no response
-- request, no routing and no page of its own. Three tables:
--   * alarm_source: one per sender credential. The HMAC secret is stored ENVELOPE-ENCRYPTED under the tenant ring DEK (secret_cipher): HMAC needs
--     the key itself, so a hash would not verify anything. Disable is one-way (create a new source to resume). Rotation replaces the cipher and
--     bumps secret_generation by exactly one, on an enabled source only.
--   * alarm_source_mapping: the sender's alarm kind -> a catalog alert type, with a severity ceiling that can only be info or warn. Written at
--     source creation and never changed (the app role has no UPDATE and no DELETE).
--   * alarm_ingest_event: one row per accepted (source, event id) - the idempotency arbiter - holding ids, enums, a body digest and counts only.
--     NO free text: the inbound body has no free-text field. effective_severity is CHECKed to info or warn, so no code path can store a critical.
-- The guards read no session variable (the actor is recorded by the audit trigger); every instant is the database clock.

CREATE TABLE "alarm_source" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "name" text NOT NULL,
  "secret_cipher" bytea NOT NULL,
  "secret_generation" integer DEFAULT 1 NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "created_by" uuid NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  "rotated_at" timestamptz,
  "rotated_by" uuid,
  "disabled_at" timestamptz,
  "disabled_by" uuid,
  CONSTRAINT "alarm_source_org_id_uq" UNIQUE ("organization_id", "id"),
  CONSTRAINT "alarm_source_name_len" CHECK (char_length(btrim("name")) BETWEEN 1 AND 120),
  CONSTRAINT "alarm_source_generation" CHECK ("secret_generation" >= 1),
  CONSTRAINT "alarm_source_disabled_shape" CHECK (("enabled" = ("disabled_at" IS NULL)) AND ("enabled" OR "disabled_by" IS NOT NULL))
);--> statement-breakpoint
CREATE INDEX "alarm_source_org_idx" ON "alarm_source" ("organization_id", "created_at");--> statement-breakpoint

CREATE TABLE "alarm_source_mapping" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "source_id" uuid NOT NULL,
  "alarm_kind" text NOT NULL,
  "alert_type" text NOT NULL,
  "severity_ceiling" text NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "alarm_source_mapping_source_fk"
    FOREIGN KEY ("organization_id", "source_id")
    REFERENCES "alarm_source"("organization_id", "id") ON DELETE CASCADE,
  CONSTRAINT "alarm_source_mapping_kind" CHECK ("alarm_kind" ~ '^[a-z0-9_]{1,40}$'),
  CONSTRAINT "alarm_source_mapping_alert_type" CHECK ("alert_type" IN ('alarm_ingest.nurse_call', 'alarm_ingest.patient_sensor', 'alarm_ingest.equipment')),
  CONSTRAINT "alarm_source_mapping_ceiling" CHECK ("severity_ceiling" IN ('info', 'warn'))
);--> statement-breakpoint
CREATE UNIQUE INDEX "alarm_source_mapping_one_per_kind" ON "alarm_source_mapping" ("organization_id", "source_id", "alarm_kind");--> statement-breakpoint

CREATE TABLE "alarm_ingest_event" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "source_id" uuid NOT NULL,
  "event_id" text NOT NULL,
  "payload_digest" text NOT NULL,
  "alarm_kind" text NOT NULL,
  "alert_type" text,
  "requested_severity" text,
  "effective_severity" text,
  "status" text DEFAULT 'received' NOT NULL,
  "alert_id" uuid,
  "recipient_count" integer,
  "occurred_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "alarm_ingest_event_source_fk"
    FOREIGN KEY ("organization_id", "source_id")
    REFERENCES "alarm_source"("organization_id", "id") ON DELETE CASCADE,
  CONSTRAINT "alarm_ingest_event_event_id" CHECK ("event_id" ~ '^[A-Za-z0-9._:-]{1,64}$'),
  CONSTRAINT "alarm_ingest_event_digest" CHECK ("payload_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "alarm_ingest_event_kind" CHECK ("alarm_kind" ~ '^[a-z0-9_]{1,40}$'),
  CONSTRAINT "alarm_ingest_event_status" CHECK ("status" IN ('received', 'alerted', 'no_recipients', 'unmapped')),
  CONSTRAINT "alarm_ingest_event_requested_severity" CHECK ("requested_severity" IS NULL OR "requested_severity" IN ('info', 'warn', 'critical')),
  CONSTRAINT "alarm_ingest_event_effective_severity" CHECK ("effective_severity" IS NULL OR "effective_severity" IN ('info', 'warn')),
  CONSTRAINT "alarm_ingest_event_unmapped_shape" CHECK (("status" = 'unmapped') = ("alert_type" IS NULL AND "effective_severity" IS NULL)),
  CONSTRAINT "alarm_ingest_event_alert_type" CHECK ("alert_type" IS NULL OR "alert_type" IN ('alarm_ingest.nurse_call', 'alarm_ingest.patient_sensor', 'alarm_ingest.equipment')),
  CONSTRAINT "alarm_ingest_event_settled_shape" CHECK (("status" IN ('alerted', 'no_recipients')) = ("recipient_count" IS NOT NULL)),
  CONSTRAINT "alarm_ingest_event_recipients" CHECK ("recipient_count" IS NULL OR "recipient_count" >= 0)
);--> statement-breakpoint
CREATE UNIQUE INDEX "alarm_ingest_event_one_per_id" ON "alarm_ingest_event" ("organization_id", "source_id", "event_id");--> statement-breakpoint
CREATE INDEX "alarm_ingest_event_recent_idx" ON "alarm_ingest_event" ("organization_id", "source_id", "created_at");--> statement-breakpoint

-- A source is BORN enabled at generation 1. After that only: a rotation (cipher changes, generation +1, enabled source), or a one-way disable.
CREATE OR REPLACE FUNCTION alarm_source_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT NEW.enabled OR NEW.secret_generation <> 1 OR NEW.rotated_at IS NOT NULL THEN
      RAISE EXCEPTION 'alarm_source_insert_state: a source is created enabled at generation 1' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.name IS DISTINCT FROM OLD.name
     OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'alarm_source_immutable: name, owner and creator are fixed' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT OLD.enabled THEN
    RAISE EXCEPTION 'alarm_source_final: a disabled source cannot change; create a new source' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.secret_cipher IS DISTINCT FROM OLD.secret_cipher THEN
    IF NEW.secret_generation <> OLD.secret_generation + 1 OR NOT NEW.enabled OR NEW.rotated_by IS NULL THEN
      RAISE EXCEPTION 'alarm_source_rotation: a rotation bumps the generation by one, by a person, on an enabled source' USING ERRCODE = 'check_violation';
    END IF;
    NEW.rotated_at := now();
  ELSIF NEW.secret_generation IS DISTINCT FROM OLD.secret_generation THEN
    RAISE EXCEPTION 'alarm_source_rotation: the generation changes only with the secret' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT NEW.enabled THEN
    NEW.disabled_at := now();
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_alarm_source_guard"
  BEFORE INSERT OR UPDATE ON alarm_source
  FOR EACH ROW EXECUTE FUNCTION alarm_source_guard();--> statement-breakpoint

-- An event is born 'received' (accepted, alert not yet emitted) or 'unmapped' (final). received settles once, forward only; nothing else moves.
CREATE OR REPLACE FUNCTION alarm_ingest_event_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status NOT IN ('received', 'unmapped') OR NEW.alert_id IS NOT NULL OR NEW.recipient_count IS NOT NULL THEN
      RAISE EXCEPTION 'alarm_ingest_event_insert_state: an event is born received or unmapped' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.source_id IS DISTINCT FROM OLD.source_id
     OR NEW.event_id IS DISTINCT FROM OLD.event_id OR NEW.payload_digest IS DISTINCT FROM OLD.payload_digest
     OR NEW.alarm_kind IS DISTINCT FROM OLD.alarm_kind OR NEW.alert_type IS DISTINCT FROM OLD.alert_type
     OR NEW.requested_severity IS DISTINCT FROM OLD.requested_severity
     OR NEW.effective_severity IS DISTINCT FROM OLD.effective_severity
     OR NEW.occurred_at IS DISTINCT FROM OLD.occurred_at OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'alarm_ingest_event_immutable: only the outcome settles' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status <> 'received' OR NEW.status NOT IN ('alerted', 'no_recipients') THEN
    RAISE EXCEPTION 'alarm_ingest_event_forward_only: received settles once' USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_alarm_ingest_event_guard"
  BEFORE INSERT OR UPDATE ON alarm_ingest_event
  FOR EACH ROW EXECUTE FUNCTION alarm_ingest_event_guard();--> statement-breakpoint

ALTER TABLE "alarm_source" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "alarm_source" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "alarm_source_mapping" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "alarm_source_mapping" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "alarm_ingest_event" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "alarm_ingest_event" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "alarm_source_org_isolation" ON "alarm_source"
  FOR ALL TO chartwarden_app
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "alarm_source_mapping_org_isolation" ON "alarm_source_mapping"
  FOR ALL TO chartwarden_app
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "alarm_ingest_event_org_isolation" ON "alarm_ingest_event"
  FOR ALL TO chartwarden_app
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT ON "alarm_source" TO chartwarden_app;--> statement-breakpoint
GRANT UPDATE ("secret_cipher", "secret_generation", "enabled", "rotated_at", "rotated_by", "disabled_at", "disabled_by", "updated_at")
  ON "alarm_source" TO chartwarden_app;--> statement-breakpoint
GRANT SELECT, INSERT ON "alarm_source_mapping" TO chartwarden_app;--> statement-breakpoint
GRANT SELECT, INSERT ON "alarm_ingest_event" TO chartwarden_app;--> statement-breakpoint
GRANT UPDATE ("status", "alert_id", "recipient_count", "updated_at") ON "alarm_ingest_event" TO chartwarden_app;--> statement-breakpoint

-- Audit. The source's audit row omits the sealed secret (recorded as changed, never copied into the immutable log). Mapping and event rows hold
-- ids, enums and counts only, so the generic trigger fits them. An ingest is attributed to the system actor (no app.user_id on the inbound route).
CREATE OR REPLACE FUNCTION audit_phi_write_alarm_source() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_before jsonb; v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN public.audit_scrub(to_jsonb(OLD), ARRAY['secret_cipher']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN public.audit_scrub(to_jsonb(NEW), ARRAY['secret_cipher']::text[]) ELSE NULL END;
  INSERT INTO public.audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id,
    correlation_id, outcome, severity, before, after, context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    CASE WHEN COALESCE(current_setting('app.user_id', true), '') = '' THEN 'system' ELSE 'user' END::audit_actor_kind,
    TG_TABLE_NAME || '.' || lower(TG_OP), TG_TABLE_NAME,
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
ALTER FUNCTION audit_phi_write_alarm_source() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_alarm_source"
  AFTER INSERT OR UPDATE OR DELETE ON alarm_source
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_alarm_source();--> statement-breakpoint
CREATE TRIGGER "alarm_source_mapping_audit"
  AFTER INSERT OR UPDATE OR DELETE ON alarm_source_mapping
  FOR EACH ROW EXECUTE FUNCTION chartwarden_audit_trigger();--> statement-breakpoint
CREATE TRIGGER "alarm_ingest_event_audit"
  AFTER INSERT OR UPDATE OR DELETE ON alarm_ingest_event
  FOR EACH ROW EXECUTE FUNCTION chartwarden_audit_trigger();--> statement-breakpoint

GRANT SELECT, DELETE ON "alarm_source" TO chartwarden_destruction;--> statement-breakpoint
GRANT SELECT, DELETE ON "alarm_source_mapping" TO chartwarden_destruction;--> statement-breakpoint
GRANT SELECT, DELETE ON "alarm_ingest_event" TO chartwarden_destruction;--> statement-breakpoint
CREATE POLICY "alarm_source_destruction" ON "alarm_source"
  FOR ALL TO chartwarden_destruction
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "alarm_source_mapping_destruction" ON "alarm_source_mapping"
  FOR ALL TO chartwarden_destruction
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "alarm_ingest_event_destruction" ON "alarm_ingest_event"
  FOR ALL TO chartwarden_destruction
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint

-- The permission (mirrors 1180). Create, rotate and disable also demand a fresh step-up in the route. PROVISIONAL until compliance confirms the
-- role set (ADR-0101 open items). No clinical, aide or other default role holds it.
INSERT INTO "permission" ("key", "resource", "action", "category", "default_abac", "description") VALUES
  ('messaging.alarm_ingest.manage', 'alarm_source', 'manage', 'compliance', 'none', '')
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
INSERT INTO "role_permission" ("organization_id", "role_id", "permission_key")
SELECT r."organization_id", r."id", 'messaging.alarm_ingest.manage'
  FROM "role" r
 WHERE r."key" IN ('compliance_officer', 'administrator', 'org_admin')
   AND r."organization_id" IS NOT NULL
ON CONFLICT ("role_id", "permission_key") DO NOTHING;
