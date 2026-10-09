-- GAP-020 -- M5 `patient_wristband`: the on-file side of the BCMA `wrong_patient` arm.
--
-- Before this nothing anywhere held a wristband value, so a scanned wristband could never be compared with
-- anything and `barcode_scan_event.match_result = 'wrong_patient'` was unreachable. A wristband encodes an
-- OPAQUE random token (never an MRN or a name); this table stores only its org-salted SHA-256 digest, one row
-- per GENERATION. A reprint supersedes the previous generation in the same transaction; `voided_at` is a hard
-- kill (identity error, merge, death, compromise, record destruction) that never validates, even offline.
-- At most one ACTIVE generation per patient (partial unique index). The raw token is shown once at print time
-- and is not recoverable.
--
-- Three-column tenancy, ENABLE + FORCE RLS on the canonical `app.org_id` predicate, SELECT/INSERT/UPDATE to
-- wardenx_app (no DELETE: the app role never deletes a band; the M5 `clinical_record` destruction eraser runs on
-- the destruction connection, like every other patient-keyed M5 table), M4 write-audit trigger with
-- `payload_digest` scrubbed. Idempotent (IF NOT EXISTS / duplicate_object guards).

CREATE TABLE IF NOT EXISTS "patient_wristband" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid,
	"location_id" uuid,
	"patient_id" uuid NOT NULL,
	"generation" integer NOT NULL,
	"payload_digest" text NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"issued_by_user_id" uuid NOT NULL,
	"issue_reason" text NOT NULL,
	"superseded_at" timestamp with time zone,
	"voided_at" timestamp with time zone,
	"voided_by_user_id" uuid,
	"void_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "patient_wristband_organization_id_organization_id_fk"
		FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "patient_wristband_provider_entity_id_provider_entity_id_fk"
		FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict,
	CONSTRAINT "patient_wristband_location_id_location_id_fk"
		FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict,
	CONSTRAINT "patient_wristband_patient_id_patient_id_fk"
		FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE restrict,
	CONSTRAINT "patient_wristband_digest_chk" CHECK ("payload_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "patient_wristband_issue_reason_chk"
		CHECK ("issue_reason" IN ('first_issue','reprint_lost','reprint_damaged','reprint_other','identity_correction')),
	CONSTRAINT "patient_wristband_void_shape_chk" CHECK (("voided_at" IS NULL) = ("void_reason" IS NULL)),
	CONSTRAINT "patient_wristband_void_reason_chk"
		CHECK ("void_reason" IS NULL OR "void_reason" IN ('identity_error','patient_merged','patient_deceased','compromised')),
	CONSTRAINT "patient_wristband_superseded_order_chk"
		CHECK ("superseded_at" IS NULL OR "superseded_at" >= "issued_at")
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "patient_wristband_generation_uq"
	ON "patient_wristband" ("organization_id", "patient_id", "generation");--> statement-breakpoint
-- Also the lookup index for "which patient does this scanned token belong to".
CREATE UNIQUE INDEX IF NOT EXISTS "patient_wristband_digest_uq"
	ON "patient_wristband" ("organization_id", "payload_digest");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "patient_wristband_active_uq"
	ON "patient_wristband" ("organization_id", "patient_id")
	WHERE "superseded_at" IS NULL AND "voided_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "patient_wristband_patient_idx"
	ON "patient_wristband" ("organization_id", "patient_id");--> statement-breakpoint

ALTER TABLE "patient_wristband" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "patient_wristband" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN
  CREATE POLICY "patient_wristband_org" ON "patient_wristband"
    FOR ALL TO wardenx_app
    USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "patient_wristband" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "patient_wristband" TO wardenx_admin;--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_patient_wristband() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['payload_digest']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['payload_digest']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'patient_wristband.' || lower(TG_OP),
    'patient_wristband',
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
ALTER FUNCTION audit_phi_write_patient_wristband() OWNER TO wardenx_audit_writer;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_audit_patient_wristband" ON patient_wristband;--> statement-breakpoint
CREATE TRIGGER "trg_audit_patient_wristband" AFTER INSERT OR UPDATE OR DELETE ON patient_wristband
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_patient_wristband();
