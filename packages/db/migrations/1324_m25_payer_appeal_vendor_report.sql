-- compat: expand
-- M25 (ADR-0053 amendment D7) - payer_appeal_vendor_report: each appeal event a clearinghouse reported (today Claim.MD's
-- `appeal` webhook, via m23.clearinghouse.appeal_reported) and what M25 did with it.
--   * A NEW table rather than vendor columns on payer_appeal_case: a unique index on an existing table is a contracting change
--     (arch:migration-compat), and this keeps the report history next to the link it creates.
--   * disposition: `opened` (a draft payer appeal level was opened from the report), `linked` (an existing in-flight level of
--     the same denial was linked to the vendor appeal), `timeline` (an event on the linked level's timeline, no state change),
--     `recorded_only` (no case could be chosen: `reason` says why; staff are alerted).
--   * One vendor appeal binds at most one case: a partial unique index on (org, vendor, vendor_appeal_id) over the rows
--     that bound one (`opened` / `linked`). UNIQUE (org, source_event_key) makes the consumer idempotent.
--   * Nothing here decides, closes or withdraws a case. No PHI and no vendor free text: ids, the control number, one
--     bounded vendor word.
CREATE TABLE IF NOT EXISTS "payer_appeal_vendor_report" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "provider_entity_id" uuid NOT NULL, -- M1 provider entity (logical FK)
  "source_event_key" text NOT NULL CHECK (char_length("source_event_key") BETWEEN 1 AND 240),
  "vendor" text NOT NULL CHECK ("vendor" ~ '^[a-z0-9][a-z0-9_-]{0,39}$'),
  "vendor_appeal_id" text CHECK ("vendor_appeal_id" IS NULL OR "vendor_appeal_id" ~ '^[A-Za-z0-9._-]{1,64}$'),
  "vendor_status" text NOT NULL CHECK ("vendor_status" ~ '^[a-z][a-z0-9_]{0,31}$'),
  "control_number" text NOT NULL CHECK (char_length("control_number") BETWEEN 1 AND 64),
  "denial_case_id" uuid REFERENCES "denial_case"("id") ON DELETE RESTRICT,
  "payer_appeal_case_id" uuid REFERENCES "payer_appeal_case"("id") ON DELETE RESTRICT,
  "disposition" text NOT NULL CHECK ("disposition" IN ('opened','linked','timeline','recorded_only')),
  "reason" text CHECK ("reason" IS NULL OR "reason" IN (
    'no_denial','several_denials','medicare_payer','medicaid_payer','no_payer_advice','payer_unresolved',
    'no_vendor_appeal_id','not_linked','linked_elsewhere')),
  "reported_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "payer_appeal_vendor_report_source_uq" UNIQUE ("organization_id", "source_event_key"),
  CONSTRAINT "payer_appeal_vendor_report_case_chk" CHECK (
    ("disposition" = 'recorded_only') = ("payer_appeal_case_id" IS NULL)),
  CONSTRAINT "payer_appeal_vendor_report_reason_chk" CHECK (
    "disposition" IN ('opened','linked') AND "reason" IS NULL OR "disposition" IN ('timeline','recorded_only'))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payer_appeal_vendor_report_binding_uq"
  ON "payer_appeal_vendor_report" ("organization_id", "vendor", "vendor_appeal_id")
  WHERE "disposition" IN ('opened','linked');--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payer_appeal_vendor_report_case_uq"
  ON "payer_appeal_vendor_report" ("organization_id", "payer_appeal_case_id")
  WHERE "disposition" IN ('opened','linked');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payer_appeal_vendor_report_case_ix"
  ON "payer_appeal_vendor_report" ("payer_appeal_case_id") WHERE "payer_appeal_case_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payer_appeal_vendor_report_denial_ix"
  ON "payer_appeal_vendor_report" ("denial_case_id") WHERE "denial_case_id" IS NOT NULL;--> statement-breakpoint

ALTER TABLE "payer_appeal_vendor_report" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "payer_appeal_vendor_report" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "payer_appeal_vendor_report_org" ON "payer_appeal_vendor_report";--> statement-breakpoint
CREATE POLICY "payer_appeal_vendor_report_org" ON "payer_appeal_vendor_report" FOR ALL TO chartwarden_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
-- Append-only for the app role.
GRANT SELECT, INSERT ON "payer_appeal_vendor_report" TO chartwarden_app;--> statement-breakpoint
GRANT ALL ON "payer_appeal_vendor_report" TO chartwarden_admin;--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chartwarden_destruction') THEN
    GRANT SELECT, DELETE ON "payer_appeal_vendor_report" TO chartwarden_destruction;
    DROP POLICY IF EXISTS "payer_appeal_vendor_report_destruction" ON "payer_appeal_vendor_report";
    CREATE POLICY "payer_appeal_vendor_report_destruction" ON "payer_appeal_vendor_report" FOR ALL TO chartwarden_destruction
      USING (organization_id = current_setting('app.org_id', true)::uuid)
      WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
  END IF;
END $$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_payer_appeal_vendor_report() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY[]::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'payer_appeal_vendor_report.' || lower(TG_OP), 'payer_appeal_vendor_report', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', COALESCE(NEW.provider_entity_id, OLD.provider_entity_id)), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_payer_appeal_vendor_report() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_audit_payer_appeal_vendor_report" ON payer_appeal_vendor_report;--> statement-breakpoint
CREATE TRIGGER "trg_audit_payer_appeal_vendor_report" AFTER INSERT OR UPDATE OR DELETE ON payer_appeal_vendor_report FOR EACH ROW EXECUTE FUNCTION audit_phi_write_payer_appeal_vendor_report();
