-- M23 (ADR-0053 D4) -- the durable record of what we sent a clearinghouse.
--
-- Vendors expire idempotency keys (Stedi: 24 h) and share one platform credential across every tenant, so "the same
-- key + identical submission replays; anything else conflicts; tenants never collide" is kept by OUR record. A
-- submission is RESERVED before it is sent and COMPLETED once the vendor has taken it, so two concurrent submissions
-- cannot both reach the vendor; a definitive vendor refusal RELEASES the reservation.
--
--   * ORG-SCOPED (organization_id + provider_entity_id), FORCEd RLS on app.org_id. No PHI: the key and control
--     number are ours, `identity` is a SHA-256 of the submission, `clearinghouse_submission_id` is the vendor's
--     opaque id. No payload is stored.
--   * Live (non-released) keys and control numbers are unique per scope, so a key or number can be reused only
--     after a release. Rows are never deleted by the app role (billing history); only the destruction role erases.
--   * BEFORE UPDATE guard: identity columns and created_at (the first reservation, which the vendor's key window runs
--     from) are immutable; a sent or released row is final; a reserved row may change status (the status and sent
--     CHECKs bound where it can go) and have its reserved_at moved (a retake of an abandoned reservation).
-- Idempotent.

CREATE TABLE IF NOT EXISTS "clearinghouse_submission_attempt" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"usage" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"control_number" text NOT NULL,
	"kind" text NOT NULL,
	"identity" text NOT NULL,
	"status" text DEFAULT 'reserved' NOT NULL,
	"clearinghouse_submission_id" text,
	"reserved_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clearinghouse_submission_attempt_organization_id_organization_id_fk"
		FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "clearinghouse_submission_attempt_usage_chk" CHECK ("usage" IN ('test', 'production')),
	CONSTRAINT "clearinghouse_submission_attempt_kind_chk" CHECK ("kind" IN ('claim', 'noe', 'notr')),
	CONSTRAINT "clearinghouse_submission_attempt_status_chk" CHECK ("status" IN ('reserved', 'sent', 'released')),
	CONSTRAINT "clearinghouse_submission_attempt_identity_chk" CHECK ("identity" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "clearinghouse_submission_attempt_key_len_chk" CHECK (char_length("idempotency_key") BETWEEN 1 AND 200),
	CONSTRAINT "clearinghouse_submission_attempt_control_len_chk" CHECK (char_length("control_number") BETWEEN 1 AND 64),
	CONSTRAINT "clearinghouse_submission_attempt_vendor_id_len_chk" CHECK (
		"clearinghouse_submission_id" IS NULL OR char_length("clearinghouse_submission_id") BETWEEN 1 AND 200),
	-- A sent row carries the vendor id and the receipt time; no other row does.
	CONSTRAINT "clearinghouse_submission_attempt_sent_chk" CHECK (
		("status" = 'sent' AND "clearinghouse_submission_id" IS NOT NULL AND "received_at" IS NOT NULL)
		OR ("status" <> 'sent' AND "clearinghouse_submission_id" IS NULL AND "received_at" IS NULL)
	)
);--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "clearinghouse_submission_attempt_key_live_uq"
	ON "clearinghouse_submission_attempt" ("organization_id", "scope", "idempotency_key") WHERE "status" <> 'released';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "clearinghouse_submission_attempt_control_live_uq"
	ON "clearinghouse_submission_attempt" ("organization_id", "scope", "control_number") WHERE "status" <> 'released';--> statement-breakpoint
-- The vendor sender (ISA06) is the platform's, so the vendor dedupes on (sender, control number) across EVERY tenant:
-- a live control number is unique per usage mode platform-wide. A unique index is enforced regardless of RLS, so the
-- app role learns of a foreign holder through the conflict without being able to read the row.
CREATE UNIQUE INDEX IF NOT EXISTS "clearinghouse_submission_attempt_platform_control_live_uq"
	ON "clearinghouse_submission_attempt" ("usage", "control_number") WHERE "status" <> 'released';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "clearinghouse_submission_attempt_reserved_idx"
	ON "clearinghouse_submission_attempt" ("organization_id", "reserved_at") WHERE "status" = 'reserved';--> statement-breakpoint

-- Platform-wide ISA13 allocators, one per usage mode: 9 digits, never reused, and they refuse (no CYCLE) rather than wrap.
CREATE SEQUENCE IF NOT EXISTS "clearinghouse_control_number_test_seq" AS bigint MINVALUE 1 MAXVALUE 999999999 NO CYCLE;--> statement-breakpoint
CREATE SEQUENCE IF NOT EXISTS "clearinghouse_control_number_production_seq" AS bigint MINVALUE 1 MAXVALUE 999999999 NO CYCLE;--> statement-breakpoint
GRANT USAGE ON SEQUENCE "clearinghouse_control_number_test_seq", "clearinghouse_control_number_production_seq" TO wardenx_app;--> statement-breakpoint

-- Permission catalog mirror row + admin-role grants (1060's pattern): the operator command that settles an attempt
-- past the vendor's key window.
INSERT INTO "permission" ("key", "resource", "action", "category", "default_abac", "description") VALUES
  ('billing.clearinghouse.resolve_attempt', 'billing_clearinghouse_attempt', 'resolve', 'billing', 'provider_entity_billing_scope', '')
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
INSERT INTO "role_permission" ("organization_id", "role_id", "permission_key")
SELECT r."organization_id", r."id", 'billing.clearinghouse.resolve_attempt'
  FROM "role" r
 WHERE r."key" IN ('administrator', 'org_admin')
   AND r."organization_id" IS NOT NULL
ON CONFLICT ("role_id", "permission_key") DO NOTHING;--> statement-breakpoint

ALTER TABLE "clearinghouse_submission_attempt" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "clearinghouse_submission_attempt" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN
  CREATE POLICY "clearinghouse_submission_attempt_org" ON "clearinghouse_submission_attempt"
    FOR ALL TO wardenx_app
    USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
-- No DELETE for the app role: an attempt is billing history (the eraser runs as wardenx_destruction).
GRANT SELECT, INSERT, UPDATE ON "clearinghouse_submission_attempt" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "clearinghouse_submission_attempt" TO wardenx_admin;--> statement-breakpoint
DO $$ BEGIN
  GRANT SELECT, DELETE ON "clearinghouse_submission_attempt" TO wardenx_destruction;
EXCEPTION WHEN undefined_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  CREATE POLICY "clearinghouse_submission_attempt_destruction" ON "clearinghouse_submission_attempt"
    FOR ALL TO wardenx_destruction
    USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);
EXCEPTION WHEN duplicate_object OR undefined_object THEN NULL; END $$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION clearinghouse_submission_attempt_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.provider_entity_id IS DISTINCT FROM OLD.provider_entity_id
     OR NEW.scope IS DISTINCT FROM OLD.scope
     OR NEW.usage IS DISTINCT FROM OLD.usage
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.control_number IS DISTINCT FROM OLD.control_number
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.identity IS DISTINCT FROM OLD.identity
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'clearinghouse_submission_attempt identity columns are immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status <> 'reserved' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'a % clearinghouse_submission_attempt is final', OLD.status USING ERRCODE = 'check_violation';
  END IF;
  IF NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW; -- a no-op write leaves updated_at alone
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_clearinghouse_submission_attempt_guard" ON "clearinghouse_submission_attempt";--> statement-breakpoint
CREATE TRIGGER "trg_clearinghouse_submission_attempt_guard" BEFORE UPDATE ON "clearinghouse_submission_attempt"
  FOR EACH ROW EXECUTE FUNCTION clearinghouse_submission_attempt_guard();--> statement-breakpoint

-- M04 write-audit (compliance retention). Nothing here is sensitive: the key and control number are ours, `identity` is
-- a hash and the vendor id is opaque, so no column is scrubbed.
CREATE OR REPLACE FUNCTION audit_phi_write_clearinghouse_submission_attempt() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY[]::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'clearinghouse_submission_attempt.' || lower(TG_OP), 'clearinghouse_submission_attempt', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', COALESCE(NEW.provider_entity_id, OLD.provider_entity_id)), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_clearinghouse_submission_attempt() OWNER TO wardenx_audit_writer;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_audit_clearinghouse_submission_attempt" ON clearinghouse_submission_attempt;--> statement-breakpoint
CREATE TRIGGER "trg_audit_clearinghouse_submission_attempt" AFTER INSERT OR UPDATE OR DELETE ON clearinghouse_submission_attempt
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_clearinghouse_submission_attempt();
