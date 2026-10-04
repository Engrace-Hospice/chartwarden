-- M22 — DocLens records requests: sending the request by FAX (F-238).
--
-- intake_records_request_fax — one row per attempt to fax a records request's cover sheet + letter (the PDF
-- the cover-sheet route renders) through M22's outbound-fax port. Written BEFORE the provider is called
-- (`sending`), then settled to `sent` (the provider accepted it: provider + its message id, sent_at, page
-- count, the SHA-256 of the exact bytes sent) or `failed` (failure_reason). At most ONE live-or-successful
-- attempt per request (`sending` | `sent`, partial unique index) — the send is idempotent per request: a
-- repeat returns the earlier send, two concurrent clicks cannot both dial, and a failed attempt may be retried.
-- PHI by association (who holds this prospect's records): the three tenancy columns + patient_id, FORCEd RLS,
-- write-audit trigger with the destination number and the provider's failure text denylisted. No DELETE: a
-- send is history.
-- Idempotent.
CREATE TABLE IF NOT EXISTS "intake_records_request_fax" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"patient_id" uuid,
	"provider_entity_id" uuid,
	"location_id" uuid,
	"records_request_id" uuid NOT NULL,
	"referral_id" uuid NOT NULL,
	"fax_number" text NOT NULL,
	"status" text DEFAULT 'sending' NOT NULL,
	"provider" text NOT NULL,
	"provider_message_id" text,
	"page_count" integer NOT NULL,
	"document_sha256" text NOT NULL,
	"failure_reason" text,
	"sent_by_membership_id" uuid NOT NULL,
	"attempted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"correlation_id" text NOT NULL,
	CONSTRAINT "intake_records_request_fax_organization_id_organization_id_fk"
		FOREIGN KEY ("organization_id") REFERENCES "organization"("id"),
	CONSTRAINT "intake_records_request_fax_provider_entity_id_provider_entity_id_fk"
		FOREIGN KEY ("provider_entity_id") REFERENCES "provider_entity"("id"),
	CONSTRAINT "intake_records_request_fax_location_id_location_id_fk"
		FOREIGN KEY ("location_id") REFERENCES "location"("id"),
	CONSTRAINT "intake_records_request_fax_request_fk"
		FOREIGN KEY ("records_request_id") REFERENCES "intake_records_request"("id"),
	CONSTRAINT "intake_records_request_fax_status_chk"
		CHECK ("status" IN ('sending', 'sent', 'failed')),
	CONSTRAINT "intake_records_request_fax_number_chk"
		CHECK ("fax_number" ~ '^\+[1-9][0-9]{7,14}$'),
	CONSTRAINT "intake_records_request_fax_sha_chk"
		CHECK ("document_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "intake_records_request_fax_pages_chk"
		CHECK ("page_count" > 0),
	CONSTRAINT "intake_records_request_fax_shape_chk"
		CHECK (
			("status" = 'sending' AND "sent_at" IS NULL AND "failed_at" IS NULL)
			OR ("status" = 'sent' AND "sent_at" IS NOT NULL AND "provider_message_id" IS NOT NULL AND "failed_at" IS NULL)
			OR ("status" = 'failed' AND "failed_at" IS NOT NULL AND "failure_reason" IS NOT NULL AND "sent_at" IS NULL)
		)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "intake_records_request_fax_one_live_uq"
	ON "intake_records_request_fax" ("records_request_id") WHERE "status" IN ('sending', 'sent');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "intake_records_request_fax_org_request_idx"
	ON "intake_records_request_fax" ("organization_id", "records_request_id", "attempted_at");--> statement-breakpoint
ALTER TABLE "intake_records_request_fax" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "intake_records_request_fax" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN
  CREATE POLICY "intake_records_request_fax_org" ON "intake_records_request_fax"
    FOR ALL TO wardenx_app
    USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
-- No DELETE: a send attempt is history.
GRANT SELECT, INSERT, UPDATE ON "intake_records_request_fax" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "intake_records_request_fax" TO wardenx_admin;--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_intake_records_request_fax() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['fax_number', 'failure_reason']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['fax_number', 'failure_reason']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'intake_records_request_fax.' || lower(TG_OP),
    'intake_records_request_fax',
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
ALTER FUNCTION audit_phi_write_intake_records_request_fax() OWNER TO wardenx_audit_writer;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_audit_intake_records_request_fax" ON intake_records_request_fax;--> statement-breakpoint
CREATE TRIGGER "trg_audit_intake_records_request_fax" AFTER INSERT OR UPDATE OR DELETE ON intake_records_request_fax
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_intake_records_request_fax();
