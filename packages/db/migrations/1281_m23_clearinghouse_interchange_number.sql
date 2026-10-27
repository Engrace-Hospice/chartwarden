-- M23 / ADR-0053 D4: the interchange control number (ISA13) an 837I was rendered with, remembered per submission.
--
-- The submit and retry workers render the interchange BEFORE the transport reserves its attempt row, so the number has to
-- be fixed first and has to survive a redelivery: a job that dies after the vendor took the file (before its own
-- transaction commits) is delivered again, and it must render the identical ISA13, or the transport sees a
-- different payload under the same idempotency key. The number comes from the platform-wide per-usage sequence that
-- already backs `allocateControlNumber` (9 digits, never reused, no CYCLE), so two submissions never share one; this
-- table only remembers which submission drew which. It replaces a 32-bit hash of the claim control number, which
-- collides at about one pair in 45,000 attempts.
--
-- Written by the durable attempt store on its own org-scoped connection (not the worker's transaction), so the memo is
-- committed before the file is sent. The app role reads and inserts; it never updates or deletes.
CREATE TABLE IF NOT EXISTS "clearinghouse_interchange_number" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "scope" text NOT NULL CHECK (char_length("scope") BETWEEN 1 AND 200),
  "idempotency_key" text NOT NULL CHECK (char_length("idempotency_key") BETWEEN 1 AND 200),
  "usage" text NOT NULL CHECK ("usage" IN ('test','production')),
  "interchange_number" bigint NOT NULL CHECK ("interchange_number" BETWEEN 1 AND 999999999),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "clearinghouse_interchange_number_key" UNIQUE ("organization_id", "scope", "idempotency_key"),
  -- Defence in depth: the vendor dedupes on the platform sender, so a number is unique per usage mode across tenants.
  CONSTRAINT "clearinghouse_interchange_number_platform_uq" UNIQUE ("usage", "interchange_number")
);--> statement-breakpoint
ALTER TABLE "clearinghouse_interchange_number" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "clearinghouse_interchange_number" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "clearinghouse_interchange_number_org" ON "clearinghouse_interchange_number";--> statement-breakpoint
CREATE POLICY "clearinghouse_interchange_number_org" ON "clearinghouse_interchange_number" FOR ALL TO chartwarden_app
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT ON "clearinghouse_interchange_number" TO chartwarden_app;--> statement-breakpoint
-- Tenant erasure: the organization FK is RESTRICT, so the eraser must be able to delete these rows (as 1067 does).
DO $$ BEGIN
  GRANT SELECT, DELETE ON "clearinghouse_interchange_number" TO chartwarden_destruction;
EXCEPTION WHEN undefined_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  CREATE POLICY "clearinghouse_interchange_number_destruction" ON "clearinghouse_interchange_number"
    FOR ALL TO chartwarden_destruction
    USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);
EXCEPTION WHEN duplicate_object OR undefined_object THEN NULL; END $$;--> statement-breakpoint
GRANT ALL ON "clearinghouse_interchange_number" TO chartwarden_admin;--> statement-breakpoint
-- M04 write-audit (operational retention). The key and the number are ours: nothing here is sensitive.
CREATE OR REPLACE FUNCTION audit_phi_write_clearinghouse_interchange_number() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY[]::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'clearinghouse_interchange_number.' || lower(TG_OP), 'clearinghouse_interchange_number', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('usage', COALESCE(NEW.usage, OLD.usage)), 'operational');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_clearinghouse_interchange_number() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_audit_clearinghouse_interchange_number" ON clearinghouse_interchange_number;--> statement-breakpoint
CREATE TRIGGER "trg_audit_clearinghouse_interchange_number" AFTER INSERT OR UPDATE OR DELETE ON clearinghouse_interchange_number FOR EACH ROW EXECUTE FUNCTION audit_phi_write_clearinghouse_interchange_number();
