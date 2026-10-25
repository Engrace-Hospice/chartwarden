-- M25 / #717: where the clearinghouse 835 poll stands, per (provider entity, vendor, usage). The cursor is an opaque
-- vendor position (no PHI, no remittance content). A different vendor or test/production mode has its own row, so
-- switching one never feeds another's cursor to it. The app role can read, insert and move the cursor; never delete.
CREATE TABLE IF NOT EXISTS "remittance_pull_cursor" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "provider_entity_id" uuid NOT NULL,
  "vendor" text NOT NULL CHECK (btrim("vendor") <> ''),
  "usage" text NOT NULL CHECK ("usage" IN ('test','production')),
  "cursor" text NOT NULL CHECK (char_length("cursor") BETWEEN 1 AND 512),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "remittance_pull_cursor_key" UNIQUE ("organization_id", "provider_entity_id", "vendor", "usage")
);--> statement-breakpoint
ALTER TABLE "remittance_pull_cursor" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "remittance_pull_cursor" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "remittance_pull_cursor_org" ON "remittance_pull_cursor";--> statement-breakpoint
CREATE POLICY "remittance_pull_cursor_org" ON "remittance_pull_cursor" FOR ALL TO chartwarden_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT ON "remittance_pull_cursor" TO chartwarden_app;--> statement-breakpoint
GRANT UPDATE ("cursor", "updated_at") ON "remittance_pull_cursor" TO chartwarden_app;--> statement-breakpoint
GRANT ALL ON "remittance_pull_cursor" TO chartwarden_admin;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_remittance_pull_cursor() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY[]::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'remittance_pull_cursor.' || lower(TG_OP), 'remittance_pull_cursor', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), '')), 'operational');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_remittance_pull_cursor() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_audit_remittance_pull_cursor" ON remittance_pull_cursor;--> statement-breakpoint
CREATE TRIGGER "trg_audit_remittance_pull_cursor" AFTER INSERT OR UPDATE OR DELETE ON remittance_pull_cursor FOR EACH ROW EXECUTE FUNCTION audit_phi_write_remittance_pull_cursor();
