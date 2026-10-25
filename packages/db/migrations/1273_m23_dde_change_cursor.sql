-- M23 / #793 (ADR-0103): ingest of the DDE provider's cursor-paged daily change report.
--
--   1. dde_change_cursor: where the change-report poll stands per (org, provider entity, vendor, usage, OPERATOR). The
--      operator is part of the key because a DDE ID is per person (ADR-0103 D4): the provider is read as the operator
--      who submitted the awaiting item. The cursor is an opaque vendor token (no PHI, no MBI). `version` makes the move a
--      compare-and-set, so two overlapping ticks can neither double-advance nor regress it. The app role reads, inserts
--      and moves a cursor; it never deletes one.
--   2. dde_change_exception: the bounded record of change events the ingest did not apply: `unmatched` (no queue item
--      carries that provider reference; counted, logged once, never stalls the stream) and `refused` (the event named an
--      item but the answer is unusable; counted, and quarantined after a cap so the stream moves on). Keyed on the vendor
--      event id; ids, counters and a code only (no vendor text). The app role never deletes.
--   3. A partial index for the lookup by provider reference (dde_work_item.provider_reference, migration 1271).
-- Idempotent.

CREATE TABLE IF NOT EXISTS "dde_change_cursor" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "provider_entity_id" uuid NOT NULL,
  "vendor" text NOT NULL CHECK (btrim("vendor") <> ''),
  "usage" text NOT NULL CHECK ("usage" IN ('test','production')),
  "operator_membership_id" uuid NOT NULL,
  "cursor" text CHECK ("cursor" IS NULL OR char_length("cursor") BETWEEN 1 AND 512),
  "version" bigint NOT NULL DEFAULT 1 CHECK ("version" >= 1),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "dde_change_cursor_key" UNIQUE ("organization_id", "provider_entity_id", "vendor", "usage", "operator_membership_id")
);--> statement-breakpoint
ALTER TABLE "dde_change_cursor" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "dde_change_cursor" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "dde_change_cursor_org" ON "dde_change_cursor";--> statement-breakpoint
CREATE POLICY "dde_change_cursor_org" ON "dde_change_cursor" FOR ALL TO chartwarden_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT ON "dde_change_cursor" TO chartwarden_app;--> statement-breakpoint
GRANT UPDATE ("cursor", "version", "updated_at") ON "dde_change_cursor" TO chartwarden_app;--> statement-breakpoint
GRANT ALL ON "dde_change_cursor" TO chartwarden_admin;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "dde_change_exception" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "provider_entity_id" uuid NOT NULL,
  "vendor" text NOT NULL CHECK (btrim("vendor") <> ''),
  "usage" text NOT NULL CHECK ("usage" IN ('test','production')),
  "event_id" text NOT NULL CHECK ("event_id" ~ '^[A-Za-z0-9:._-]{1,128}$'),
  "kind" text NOT NULL CHECK ("kind" IN ('unmatched','refused')),
  "seen_count" integer NOT NULL DEFAULT 1 CHECK ("seen_count" >= 1),
  "reason_code" text NOT NULL CHECK ("reason_code" ~ '^[A-Z0-9_]{1,64}$'),
  "quarantined_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "dde_change_exception_key" UNIQUE ("organization_id", "provider_entity_id", "vendor", "usage", "event_id")
);--> statement-breakpoint
ALTER TABLE "dde_change_exception" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "dde_change_exception" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "dde_change_exception_org" ON "dde_change_exception";--> statement-breakpoint
CREATE POLICY "dde_change_exception_org" ON "dde_change_exception" FOR ALL TO chartwarden_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT ON "dde_change_exception" TO chartwarden_app;--> statement-breakpoint
GRANT UPDATE ("kind", "seen_count", "reason_code", "quarantined_at", "updated_at") ON "dde_change_exception" TO chartwarden_app;--> statement-breakpoint
GRANT ALL ON "dde_change_exception" TO chartwarden_admin;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "dde_work_item_provider_reference_idx"
  ON "dde_work_item" ("organization_id", "provider_entity_id", "provider_reference")
  WHERE "provider_reference" IS NOT NULL;--> statement-breakpoint

-- M04 write-audit (operational retention). Both tables hold opaque tokens and counters: nothing here is sensitive.
CREATE OR REPLACE FUNCTION audit_phi_write_dde_change_cursor() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY[]::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'dde_change_cursor.' || lower(TG_OP), 'dde_change_cursor', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', COALESCE(NEW.provider_entity_id, OLD.provider_entity_id)), 'operational');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_dde_change_cursor() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_audit_dde_change_cursor" ON dde_change_cursor;--> statement-breakpoint
CREATE TRIGGER "trg_audit_dde_change_cursor" AFTER INSERT OR UPDATE OR DELETE ON dde_change_cursor FOR EACH ROW EXECUTE FUNCTION audit_phi_write_dde_change_cursor();--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_dde_change_exception() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY[]::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'dde_change_exception.' || lower(TG_OP), 'dde_change_exception', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', COALESCE(NEW.provider_entity_id, OLD.provider_entity_id)), 'operational');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_dde_change_exception() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_audit_dde_change_exception" ON dde_change_exception;--> statement-breakpoint
CREATE TRIGGER "trg_audit_dde_change_exception" AFTER INSERT OR UPDATE OR DELETE ON dde_change_exception FOR EACH ROW EXECUTE FUNCTION audit_phi_write_dde_change_exception();
