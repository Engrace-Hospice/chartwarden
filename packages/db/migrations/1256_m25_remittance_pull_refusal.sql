-- M25 / #717 follow-up: bounded poison-file policy for the 835 pull. One row per (provider entity, vendor, usage, vendor
-- remittance id) that `receiveAdvice` refused: the consecutive refusal count and, once it reaches the cap, the quarantine
-- stamp (the cursor then advances past the file). Keyed on the file content hash too: a re-offered file whose bytes
-- changed is a new file and is retried. No PHI and no vendor text: ids, a hash and a code only. The app role can read,
-- insert and bump or zero the counters; never delete; identity columns are not updatable.
-- Operator release (admin connection, audited by the trigger below; release is an operator action by convention; the app code never un-quarantines): a quarantined file is
-- re-read from the vendor only if the cursor is also moved back, so release it and rewind the cursor in one transaction:
--   UPDATE remittance_pull_refusal SET quarantined_at = NULL, refusal_count = 0
--    WHERE organization_id = :org AND provider_entity_id = :pe AND vendor = :vendor AND remittance_id = :id;
--   UPDATE remittance_pull_cursor SET cursor = :cursor_before_the_file, updated_at = now() WHERE <same key>;
CREATE TABLE IF NOT EXISTS "remittance_pull_refusal" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "provider_entity_id" uuid NOT NULL,
  "vendor" text NOT NULL CHECK (btrim("vendor") <> ''),
  "usage" text NOT NULL CHECK ("usage" IN ('test','production')),
  "remittance_id" text NOT NULL CHECK (char_length("remittance_id") BETWEEN 1 AND 512),
  "file_sha256" text NOT NULL CHECK ("file_sha256" ~ '^[0-9a-f]{64}$'),
  "refusal_count" integer NOT NULL DEFAULT 1 CHECK ("refusal_count" >= 0),
  "reason_code" text NOT NULL CHECK (char_length("reason_code") BETWEEN 1 AND 64),
  "quarantined_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "remittance_pull_refusal_key" UNIQUE ("organization_id", "provider_entity_id", "vendor", "usage", "remittance_id", "file_sha256")
);--> statement-breakpoint
ALTER TABLE "remittance_pull_refusal" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "remittance_pull_refusal" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "remittance_pull_refusal_org" ON "remittance_pull_refusal";--> statement-breakpoint
CREATE POLICY "remittance_pull_refusal_org" ON "remittance_pull_refusal" FOR ALL TO chartwarden_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT ON "remittance_pull_refusal" TO chartwarden_app;--> statement-breakpoint
GRANT UPDATE ("refusal_count", "reason_code", "quarantined_at", "updated_at") ON "remittance_pull_refusal" TO chartwarden_app;--> statement-breakpoint
GRANT ALL ON "remittance_pull_refusal" TO chartwarden_admin;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_remittance_pull_refusal() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY[]::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'remittance_pull_refusal.' || lower(TG_OP), 'remittance_pull_refusal', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), '')), 'operational');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_remittance_pull_refusal() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_audit_remittance_pull_refusal" ON remittance_pull_refusal;--> statement-breakpoint
CREATE TRIGGER "trg_audit_remittance_pull_refusal" AFTER INSERT OR UPDATE OR DELETE ON remittance_pull_refusal FOR EACH ROW EXECUTE FUNCTION audit_phi_write_remittance_pull_refusal();
