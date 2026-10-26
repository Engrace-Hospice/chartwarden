-- M41 Billing - Commercial: acknowledgment ingestion (ADR-0053 D2/D7, ADR-0100 D9). Two tables and one column.
--
--   commercial_acknowledgment  one clearinghouse event about a submission: the stage (`clearinghouse` = the 999-level answer, `payer` =
--                              the 277CA-level answer), the disposition, the reason CODES and the payer's claim number. Codes and ids
--                              only (no PHI, no payload). UNIQUE on (organization, clearinghouse, vendor event id): a duplicate or
--                              out-of-order delivery collapses on the key and changes nothing.
--   commercial_ack_cursor      where the acknowledgment pull stands per (organization, provider entity, vendor, usage): an opaque vendor
--                              position moved by compare-and-set on `version` (the M23 #749 pattern; its own table because M23's
--                              cursor rows are keyed by Medicare stage and would be shared with, and advanced by, M23's crons).
--   commercial_submission.clearinghouse_accepted_at   stamped by the first clearinghouse-stage acceptance. It never advances the claim to
--                              `accepted` (that is the payer stage only, ADR-0053 D2).
-- Org scoped (canonical app.org_id RLS, FORCEd, no DELETE for the app role), write-audit triggers.

ALTER TABLE "commercial_submission" ADD COLUMN IF NOT EXISTS "clearinghouse_accepted_at" timestamptz;--> statement-breakpoint
GRANT UPDATE ("clearinghouse_accepted_at") ON "commercial_submission" TO chartwarden_app;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "commercial_acknowledgment" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "provider_entity_id" uuid NOT NULL REFERENCES "provider_entity"("id") ON DELETE RESTRICT,
  "location_id" uuid REFERENCES "location"("id") ON DELETE RESTRICT,
  "claim_id" uuid NOT NULL,
  "submission_id" uuid NOT NULL,
  "clearinghouse_key" text NOT NULL CHECK ("clearinghouse_key" ~ '^[a-z0-9][a-z0-9_-]{0,39}$'),
  "event_id" text NOT NULL CHECK (char_length("event_id") BETWEEN 1 AND 256),
  "stage" text NOT NULL CHECK ("stage" IN ('clearinghouse','payer')),
  "disposition" text NOT NULL CHECK ("disposition" IN ('accepted','rejected','partial')),
  "reason_codes" text[] NOT NULL DEFAULT '{}' CHECK (cardinality("reason_codes") <= 50),
  "payer_claim_number" text CHECK ("payer_claim_number" IS NULL OR char_length("payer_claim_number") BETWEEN 1 AND 128),
  "occurred_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "commercial_acknowledgment_claim_fk" FOREIGN KEY ("claim_id", "organization_id") REFERENCES "commercial_claim"("id", "organization_id") ON DELETE RESTRICT,
  CONSTRAINT "commercial_acknowledgment_submission_fk" FOREIGN KEY ("submission_id", "organization_id") REFERENCES "commercial_submission"("id", "organization_id") ON DELETE RESTRICT,
  CONSTRAINT "commercial_acknowledgment_partial_payer_only" CHECK ("disposition" <> 'partial' OR "stage" = 'payer')
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "commercial_acknowledgment_event_uq" ON "commercial_acknowledgment" ("organization_id", "clearinghouse_key", "event_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commercial_acknowledgment_claim_ix" ON "commercial_acknowledgment" ("claim_id", "created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commercial_acknowledgment_claim_fk_ix" ON "commercial_acknowledgment" ("claim_id", "organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commercial_acknowledgment_submission_fk_ix" ON "commercial_acknowledgment" ("submission_id", "organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commercial_acknowledgment_org_ix" ON "commercial_acknowledgment" ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commercial_acknowledgment_pe_ix" ON "commercial_acknowledgment" ("provider_entity_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commercial_acknowledgment_location_ix" ON "commercial_acknowledgment" ("location_id") WHERE "location_id" IS NOT NULL;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "commercial_ack_cursor" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "provider_entity_id" uuid NOT NULL REFERENCES "provider_entity"("id") ON DELETE RESTRICT,
  "vendor" text NOT NULL CHECK (btrim("vendor") <> ''),
  "usage" text NOT NULL CHECK ("usage" IN ('test','production')),
  "cursor" text CHECK ("cursor" IS NULL OR char_length("cursor") BETWEEN 1 AND 512),
  "version" bigint NOT NULL DEFAULT 1 CHECK ("version" >= 1),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "commercial_ack_cursor_key" UNIQUE ("organization_id", "provider_entity_id", "vendor", "usage")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commercial_ack_cursor_pe_ix" ON "commercial_ack_cursor" ("provider_entity_id");--> statement-breakpoint

ALTER TABLE "commercial_acknowledgment" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "commercial_acknowledgment" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "commercial_acknowledgment_org" ON "commercial_acknowledgment";--> statement-breakpoint
CREATE POLICY "commercial_acknowledgment_org" ON "commercial_acknowledgment" FOR ALL TO chartwarden_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
ALTER TABLE "commercial_ack_cursor" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "commercial_ack_cursor" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "commercial_ack_cursor_org" ON "commercial_ack_cursor";--> statement-breakpoint
CREATE POLICY "commercial_ack_cursor_org" ON "commercial_ack_cursor" FOR ALL TO chartwarden_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT ON "commercial_acknowledgment" TO chartwarden_app;--> statement-breakpoint
GRANT SELECT, INSERT ON "commercial_ack_cursor" TO chartwarden_app;--> statement-breakpoint
GRANT UPDATE ("cursor", "version", "updated_at") ON "commercial_ack_cursor" TO chartwarden_app;--> statement-breakpoint
GRANT ALL ON "commercial_acknowledgment" TO chartwarden_admin;--> statement-breakpoint
GRANT ALL ON "commercial_ack_cursor" TO chartwarden_admin;--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_commercial_acknowledgment() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY[]::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'commercial_acknowledgment.' || lower(TG_OP), 'commercial_acknowledgment', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), '')), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_commercial_acknowledgment() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_audit_commercial_acknowledgment" ON commercial_acknowledgment;--> statement-breakpoint
CREATE TRIGGER "trg_audit_commercial_acknowledgment" AFTER INSERT OR UPDATE OR DELETE ON commercial_acknowledgment FOR EACH ROW EXECUTE FUNCTION audit_phi_write_commercial_acknowledgment();--> statement-breakpoint

-- The cursor is an opaque vendor token: nothing sensitive, operational retention (the M23 #749 precedent).
CREATE OR REPLACE FUNCTION audit_phi_write_commercial_ack_cursor() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY[]::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'commercial_ack_cursor.' || lower(TG_OP), 'commercial_ack_cursor', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', COALESCE(NEW.provider_entity_id, OLD.provider_entity_id)), 'operational');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_commercial_ack_cursor() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_audit_commercial_ack_cursor" ON commercial_ack_cursor;--> statement-breakpoint
CREATE TRIGGER "trg_audit_commercial_ack_cursor" AFTER INSERT OR UPDATE OR DELETE ON commercial_ack_cursor FOR EACH ROW EXECUTE FUNCTION audit_phi_write_commercial_ack_cursor();
