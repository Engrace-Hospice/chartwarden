-- M23 / #749: where the clearinghouse acknowledgment poll (999 / 277CA crons) stands, per (org, provider entity, vendor,
-- usage, stage). The cursor is an opaque vendor position (no PHI). The two crons read the SAME vendor event stream and
-- each keeps the events of its own stage, so each stage has its own row. A different vendor or test/production mode has
-- its own row too, so switching one never feeds another's cursor to it.
--
-- `version` makes the move a compare-and-set (UPDATE ... WHERE version = <read>): two overlapping ticks can neither
-- double-advance nor regress the position. `cursor` is NULL after a reset (the vendor refused the stored position and
-- the stream is re-read from its start). The app role reads, inserts and moves a cursor; it never deletes one.
CREATE TABLE IF NOT EXISTS "clearinghouse_ack_cursor" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "provider_entity_id" uuid NOT NULL,
  "vendor" text NOT NULL CHECK (btrim("vendor") <> ''),
  "usage" text NOT NULL CHECK ("usage" IN ('test','production')),
  "kind" text NOT NULL CHECK ("kind" IN ('ack_999','ack_277ca')),
  "cursor" text CHECK ("cursor" IS NULL OR char_length("cursor") BETWEEN 1 AND 512),
  "version" bigint NOT NULL DEFAULT 1 CHECK ("version" >= 1),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "clearinghouse_ack_cursor_key" UNIQUE ("organization_id", "provider_entity_id", "vendor", "usage", "kind")
);--> statement-breakpoint
ALTER TABLE "clearinghouse_ack_cursor" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "clearinghouse_ack_cursor" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "clearinghouse_ack_cursor_org" ON "clearinghouse_ack_cursor";--> statement-breakpoint
CREATE POLICY "clearinghouse_ack_cursor_org" ON "clearinghouse_ack_cursor" FOR ALL TO chartwarden_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT ON "clearinghouse_ack_cursor" TO chartwarden_app;--> statement-breakpoint
GRANT UPDATE ("cursor", "version", "updated_at") ON "clearinghouse_ack_cursor" TO chartwarden_app;--> statement-breakpoint
GRANT ALL ON "clearinghouse_ack_cursor" TO chartwarden_admin;--> statement-breakpoint
-- M04 write-audit (operational retention). The cursor is an opaque vendor token: nothing here is sensitive.
CREATE OR REPLACE FUNCTION audit_phi_write_clearinghouse_ack_cursor() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY[]::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'clearinghouse_ack_cursor.' || lower(TG_OP), 'clearinghouse_ack_cursor', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', COALESCE(NEW.provider_entity_id, OLD.provider_entity_id)), 'operational');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_clearinghouse_ack_cursor() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_audit_clearinghouse_ack_cursor" ON clearinghouse_ack_cursor;--> statement-breakpoint
CREATE TRIGGER "trg_audit_clearinghouse_ack_cursor" AFTER INSERT OR UPDATE OR DELETE ON clearinghouse_ack_cursor FOR EACH ROW EXECUTE FUNCTION audit_phi_write_clearinghouse_ack_cursor();
