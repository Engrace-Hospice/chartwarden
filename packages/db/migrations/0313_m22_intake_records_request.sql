-- M22 — DocLens: requesting a prospect's older records, and recognising them when they come back (F-238).
--
-- A hospice referral often lacks the evidence to qualify the prospect, so intake staff request older PCP /
-- hospital records. They come back by fax (rarely e-mail), days later, from someone who never saw our
-- referral id. The request carries a short CODE ("RR-" + 6 + a check character, an alphabet without the
-- characters OCR swaps) printed on the cover sheet; the intake job finds it on the returned pages (or in the
-- e-mail subject) and files the batch under the request's referral.
--
-- 1. intake_records_request — one outbound request: the referral (and, once resolved, patient) it is for,
--    the code (unique per org), the recipient (name / organization / fax / e-mail — PHI by association:
--    denylisted in the audit trigger), what is requested (kinds + free text, denylisted), the date range,
--    status (requested | received | partially_received | cancelled | expired), due date, who requested it.
--    Three tenancy columns, FORCEd RLS, write-audit trigger with a denylist.
-- 2. intake_upload_batch.records_request_id — the request a returned batch answers (matched by code, or
--    linked by hand at upload).
-- Idempotent.
CREATE TABLE IF NOT EXISTS "intake_records_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"patient_id" uuid,
	"provider_entity_id" uuid,
	"location_id" uuid,
	"referral_id" uuid NOT NULL,
	"request_code" text NOT NULL,
	"recipient_name" text NOT NULL,
	"recipient_organization" text,
	"recipient_fax" text,
	"recipient_email" text,
	"records_requested" jsonb NOT NULL,
	"records_requested_note" text,
	"date_range_start" date,
	"date_range_end" date,
	"status" text DEFAULT 'requested' NOT NULL,
	"due_date" date,
	"requested_by_membership_id" uuid NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"received_at" timestamp with time zone,
	"cancelled_by_membership_id" uuid,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"correlation_id" text NOT NULL,
	CONSTRAINT "intake_records_request_organization_id_organization_id_fk"
		FOREIGN KEY ("organization_id") REFERENCES "organization"("id"),
	CONSTRAINT "intake_records_request_provider_entity_id_provider_entity_id_fk"
		FOREIGN KEY ("provider_entity_id") REFERENCES "provider_entity"("id"),
	CONSTRAINT "intake_records_request_location_id_location_id_fk"
		FOREIGN KEY ("location_id") REFERENCES "location"("id"),
	CONSTRAINT "intake_records_request_status_chk"
		CHECK ("status" IN ('requested', 'received', 'partially_received', 'cancelled', 'expired')),
	CONSTRAINT "intake_records_request_code_chk"
		CHECK ("request_code" ~ '^RR-[ACDEFHJKMNPRTVWXY234679]{7}$'),
	CONSTRAINT "intake_records_request_recipient_chk"
		CHECK ("recipient_fax" IS NOT NULL OR "recipient_email" IS NOT NULL),
	CONSTRAINT "intake_records_request_kinds_chk"
		CHECK (jsonb_typeof("records_requested") = 'array'),
	CONSTRAINT "intake_records_request_range_chk"
		CHECK ("date_range_start" IS NULL OR "date_range_end" IS NULL OR "date_range_start" <= "date_range_end"),
	CONSTRAINT "intake_records_request_cancel_shape"
		CHECK (("status" = 'cancelled') = ("cancelled_at" IS NOT NULL AND "cancelled_by_membership_id" IS NOT NULL))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "intake_records_request_org_code_uq"
	ON "intake_records_request" ("organization_id", "request_code");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "intake_records_request_org_referral_idx"
	ON "intake_records_request" ("organization_id", "referral_id", "requested_at");--> statement-breakpoint
ALTER TABLE "intake_records_request" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "intake_records_request" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN
  CREATE POLICY "intake_records_request_org" ON "intake_records_request"
    FOR ALL TO wardenx_app
    USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
-- No DELETE: a request is cancelled, never erased.
GRANT SELECT, INSERT, UPDATE ON "intake_records_request" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "intake_records_request" TO wardenx_admin;--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_intake_records_request() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['recipient_name', 'recipient_organization', 'recipient_fax', 'recipient_email', 'records_requested_note', 'cancel_reason']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['recipient_name', 'recipient_organization', 'recipient_fax', 'recipient_email', 'records_requested_note', 'cancel_reason']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'intake_records_request.' || lower(TG_OP),
    'intake_records_request',
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
ALTER FUNCTION audit_phi_write_intake_records_request() OWNER TO wardenx_audit_writer;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_audit_intake_records_request" ON intake_records_request;--> statement-breakpoint
CREATE TRIGGER "trg_audit_intake_records_request" AFTER INSERT OR UPDATE OR DELETE ON intake_records_request
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_intake_records_request();--> statement-breakpoint

ALTER TABLE "intake_upload_batch"
  ADD COLUMN IF NOT EXISTS "records_request_id" uuid;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "intake_upload_batch" ADD CONSTRAINT "intake_upload_batch_records_request_fk"
    FOREIGN KEY ("records_request_id") REFERENCES "intake_records_request"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "intake_batch_org_records_request_idx"
  ON "intake_upload_batch" ("organization_id", "records_request_id") WHERE "records_request_id" IS NOT NULL;
