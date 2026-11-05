-- compat: expand
-- M41 (ADR-0100 note, ADR-0053 amendment D7) - commercial_enrollment_report: an ADVISORY enrollment status a clearinghouse
-- reported for a provider entity (today Claim.MD's `enroll` webhook, via m23.clearinghouse.enrollment_reported).
--   * Nothing here changes a send gate. Staff confirm a report by applying it through the EXISTING enrollments POST/PATCH
--     (step-up, no AI actor, Idempotency-Key), then resolve the report `applied`; or dismiss it. commercial_payer_enrollment
--     is never written from a report.
--   * `payer_id` is our payer when exactly one of the tenant's commercial_payer_route rows on this clearinghouse carries the
--     reported payer id; NULL when none or several do (staff pick the payer).
--   * `suggested_status` is set only for the exact vendor word `enrolled`; every other word is shown, never mapped.
--   * One open report per (provider entity, payer, enroll type): a newer report (by `reported_at`) supersedes older open ones;
--     an older one arriving late is stored already superseded.
--   * No PHI, no free text: ids, codes, one bounded vendor word. UNIQUE (organization_id, source_event_key) makes the
--     consumer idempotent on a redelivered event.
CREATE TABLE IF NOT EXISTS "commercial_enrollment_report" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "provider_entity_id" uuid NOT NULL, -- M1 provider entity (logical FK)
  "payer_id" uuid, -- M40 canonical payer (logical FK), NULL when the route mapping is missing or ambiguous
  "clearinghouse_key" text NOT NULL CHECK ("clearinghouse_key" ~ '^[a-z0-9][a-z0-9_-]{0,39}$'),
  "clearinghouse_payer_id" text CHECK ("clearinghouse_payer_id" IS NULL OR "clearinghouse_payer_id" ~ '^[A-Za-z0-9._-]{1,40}$'),
  "enroll_type" text NOT NULL CHECK ("enroll_type" IN ('era','1500','500','ub','elig','attach','unrecognized')),
  "vendor_status" text NOT NULL CHECK ("vendor_status" ~ '^[a-z][a-z0-9_]{0,31}$'),
  "suggested_status" text CHECK ("suggested_status" IS NULL OR "suggested_status" = 'enrolled'),
  "vendor_enroll_id" text CHECK ("vendor_enroll_id" IS NULL OR "vendor_enroll_id" ~ '^[A-Za-z0-9._-]{1,64}$'),
  "source_event_key" text NOT NULL CHECK (char_length("source_event_key") BETWEEN 1 AND 240),
  "reported_at" timestamptz NOT NULL,
  "state" text NOT NULL DEFAULT 'open' CHECK ("state" IN ('open','applied','dismissed','superseded')),
  "resolved_by_user_id" uuid,
  "resolved_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "commercial_enrollment_report_source_uq" UNIQUE ("organization_id", "source_event_key"),
  CONSTRAINT "commercial_enrollment_report_resolution_chk" CHECK (
    ("state" IN ('applied','dismissed')) = ("resolved_at" IS NOT NULL))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commercial_enrollment_report_open_ix"
  ON "commercial_enrollment_report" ("organization_id", "provider_entity_id", "state");--> statement-breakpoint

ALTER TABLE "commercial_enrollment_report" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "commercial_enrollment_report" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "commercial_enrollment_report_org" ON "commercial_enrollment_report";--> statement-breakpoint
CREATE POLICY "commercial_enrollment_report_org" ON "commercial_enrollment_report" FOR ALL TO chartwarden_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
-- The consumer inserts and supersedes; staff resolve. The anchor columns never change; no DELETE for the app role.
GRANT SELECT, INSERT ON "commercial_enrollment_report" TO chartwarden_app;--> statement-breakpoint
GRANT UPDATE ("state", "resolved_by_user_id", "resolved_at", "updated_at") ON "commercial_enrollment_report" TO chartwarden_app;--> statement-breakpoint
GRANT ALL ON "commercial_enrollment_report" TO chartwarden_admin;--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chartwarden_destruction') THEN
    GRANT SELECT, DELETE ON "commercial_enrollment_report" TO chartwarden_destruction;
    DROP POLICY IF EXISTS "commercial_enrollment_report_destruction" ON "commercial_enrollment_report";
    CREATE POLICY "commercial_enrollment_report_destruction" ON "commercial_enrollment_report" FOR ALL TO chartwarden_destruction
      USING (organization_id = current_setting('app.org_id', true)::uuid)
      WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
  END IF;
END $$;--> statement-breakpoint

-- M4 write-audit trigger (the 1265 shape). No free text and no PHI, so nothing is scrubbed.
CREATE OR REPLACE FUNCTION audit_phi_write_commercial_enrollment_report() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY[]::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'commercial_enrollment_report.' || lower(TG_OP), 'commercial_enrollment_report', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', COALESCE(NEW.provider_entity_id, OLD.provider_entity_id)), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_commercial_enrollment_report() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_audit_commercial_enrollment_report" ON commercial_enrollment_report;--> statement-breakpoint
CREATE TRIGGER "trg_audit_commercial_enrollment_report" AFTER INSERT OR UPDATE OR DELETE ON commercial_enrollment_report FOR EACH ROW EXECUTE FUNCTION audit_phi_write_commercial_enrollment_report();
