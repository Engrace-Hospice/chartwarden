-- M10 HOPE modernization Phase 1A: versioned CMS HOPE specification foundation
-- plus canonical item-answer storage. Additive only: the existing hope_assessment.data
-- jsonb remains in place and current workflows are not made dependent on item answers.

CREATE TYPE "public"."hope_isc" AS ENUM('HA', 'HUV', 'HD', 'XX');--> statement-breakpoint
CREATE TYPE "public"."hope_answer_state" AS ENUM('answered', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."hope_answer_source" AS ENUM('user', 'patient_prefill', 'admission_prefill', 'derived', 'imported', 'correction_copy');--> statement-breakpoint
CREATE TYPE "public"."hope_spec_item_kind" AS ENUM('assessment', 'control', 'calculated', 'filler');--> statement-breakpoint

CREATE TABLE "hope_spec_version" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "code" text NOT NULL,
  "item_set_version" text NOT NULL,
  "effective_from" date NOT NULL,
  "effective_to" date,
  "source_label" text NOT NULL,
  "source_release" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_hope_spec_version_code" ON "hope_spec_version" USING btree ("code");--> statement-breakpoint
CREATE INDEX "idx_hope_spec_version_effective" ON "hope_spec_version" USING btree ("effective_from","effective_to");--> statement-breakpoint

CREATE TABLE "hope_spec_item" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "spec_version_id" uuid NOT NULL,
  "cms_item_master_key" text NOT NULL,
  "item_code" text NOT NULL,
  "database_item_code" text,
  "short_label" text NOT NULL,
  "section_label" text NOT NULL,
  "item_sort_order" integer NOT NULL,
  "section_sort_order" integer NOT NULL,
  "group_code" text,
  "loinc_id" text,
  "cms_item_type_code" text NOT NULL,
  "kind" "hope_spec_item_kind" NOT NULL,
  "fixed_record_sort_order" integer,
  "fixed_record_start_byte" integer,
  "fixed_record_end_byte" integer,
  "fixed_record_length" integer,
  "version_notes" text,
  "source_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL
);--> statement-breakpoint
ALTER TABLE "hope_spec_item" ADD CONSTRAINT "hope_spec_item_spec_version_id_hope_spec_version_id_fk" FOREIGN KEY ("spec_version_id") REFERENCES "public"."hope_spec_version"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_hope_spec_item_version_code" ON "hope_spec_item" USING btree ("spec_version_id","item_code");--> statement-breakpoint
CREATE INDEX "idx_hope_spec_item_version_sort" ON "hope_spec_item" USING btree ("spec_version_id","section_sort_order","item_sort_order");--> statement-breakpoint
CREATE INDEX "idx_hope_spec_item_cms_master_key" ON "hope_spec_item" USING btree ("cms_item_master_key");--> statement-breakpoint

CREATE TABLE "hope_spec_item_isc" (
  "spec_item_id" uuid NOT NULL,
  "isc" "hope_isc" NOT NULL,
  "active" boolean NOT NULL,
  CONSTRAINT "hope_spec_item_isc_spec_item_id_isc_pk" PRIMARY KEY("spec_item_id","isc")
);--> statement-breakpoint
ALTER TABLE "hope_spec_item_isc" ADD CONSTRAINT "hope_spec_item_isc_spec_item_id_hope_spec_item_id_fk" FOREIGN KEY ("spec_item_id") REFERENCES "public"."hope_spec_item"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_hope_spec_item_isc_active" ON "hope_spec_item_isc" USING btree ("isc","active");--> statement-breakpoint

CREATE TABLE "hope_spec_item_option" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "spec_item_id" uuid NOT NULL,
  "cms_item_value_key" text NOT NULL,
  "sort_order" integer NOT NULL,
  "value_code" text NOT NULL,
  "label" text NOT NULL,
  "loinc_id" text
);--> statement-breakpoint
ALTER TABLE "hope_spec_item_option" ADD CONSTRAINT "hope_spec_item_option_spec_item_id_hope_spec_item_id_fk" FOREIGN KEY ("spec_item_id") REFERENCES "public"."hope_spec_item"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_hope_spec_item_option_value" ON "hope_spec_item_option" USING btree ("spec_item_id","value_code");--> statement-breakpoint
CREATE INDEX "idx_hope_spec_item_option_sort" ON "hope_spec_item_option" USING btree ("spec_item_id","sort_order");--> statement-breakpoint

ALTER TABLE "hope_assessment" ADD COLUMN "spec_version_id" uuid;--> statement-breakpoint
ALTER TABLE "hope_assessment" ADD COLUMN "isc" "hope_isc";--> statement-breakpoint
ALTER TABLE "hope_assessment" ADD CONSTRAINT "hope_assessment_spec_version_id_hope_spec_version_id_fk" FOREIGN KEY ("spec_version_id") REFERENCES "public"."hope_spec_version"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_hope_assess_spec_isc_target" ON "hope_assessment" USING btree ("spec_version_id","isc","target_date");--> statement-breakpoint

CREATE TABLE "hope_assessment_answer" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "provider_entity_id" uuid,
  "location_id" uuid,
  "hope_assessment_id" uuid NOT NULL,
  "spec_version_id" uuid NOT NULL,
  "spec_item_id" uuid NOT NULL,
  "state" "hope_answer_state" NOT NULL,
  "value" jsonb,
  "source" "hope_answer_source" NOT NULL,
  "source_reference" jsonb,
  "answered_at" timestamp with time zone,
  "answered_by_membership_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "hope_answer_state_value_ck" CHECK ((state = 'skipped' AND value IS NULL) OR (state = 'answered' AND value IS NOT NULL))
);--> statement-breakpoint
ALTER TABLE "hope_assessment_answer" ADD CONSTRAINT "hope_assessment_answer_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hope_assessment_answer" ADD CONSTRAINT "hope_assessment_answer_provider_entity_id_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hope_assessment_answer" ADD CONSTRAINT "hope_assessment_answer_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hope_assessment_answer" ADD CONSTRAINT "hope_assessment_answer_spec_version_id_hope_spec_version_id_fk" FOREIGN KEY ("spec_version_id") REFERENCES "public"."hope_spec_version"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hope_assessment_answer" ADD CONSTRAINT "hope_assessment_answer_spec_item_id_hope_spec_item_id_fk" FOREIGN KEY ("spec_item_id") REFERENCES "public"."hope_spec_item"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hope_assessment_answer" ADD CONSTRAINT "hope_assessment_answer_answered_by_membership_id_membership_id_fk" FOREIGN KEY ("answered_by_membership_id") REFERENCES "public"."membership"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_hope_answer_assessment_item" ON "hope_assessment_answer" USING btree ("hope_assessment_id","spec_item_id");--> statement-breakpoint
CREATE INDEX "idx_hope_answer_assessment" ON "hope_assessment_answer" USING btree ("hope_assessment_id");--> statement-breakpoint
CREATE INDEX "idx_hope_answer_assessment_state" ON "hope_assessment_answer" USING btree ("hope_assessment_id","state");--> statement-breakpoint
CREATE INDEX "idx_hope_answer_spec_item" ON "hope_assessment_answer" USING btree ("spec_item_id");--> statement-breakpoint
CREATE INDEX "idx_hope_answer_org_created" ON "hope_assessment_answer" USING btree ("organization_id","created_at");--> statement-breakpoint

ALTER TABLE "hope_validation_finding" ADD COLUMN "spec_version_id" uuid;--> statement-breakpoint
ALTER TABLE "hope_validation_finding" ADD COLUMN "finding_kind" text;--> statement-breakpoint
ALTER TABLE "hope_validation_finding" ADD COLUMN "details" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "hope_validation_finding" ADD COLUMN "fingerprint" text;--> statement-breakpoint
ALTER TABLE "hope_validation_finding" ADD CONSTRAINT "hope_validation_finding_spec_version_id_hope_spec_version_id_fk" FOREIGN KEY ("spec_version_id") REFERENCES "public"."hope_spec_version"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_hope_finding_open_fingerprint" ON "hope_validation_finding" USING btree ("hope_assessment_id","fingerprint") WHERE resolved = false AND fingerprint IS NOT NULL;--> statement-breakpoint

ALTER TABLE "hope_spec_version" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "hope_spec_version_read" ON "hope_spec_version" FOR SELECT TO wardenx_app USING (true);
GRANT SELECT ON "hope_spec_version" TO wardenx_app;
GRANT ALL ON "hope_spec_version" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "hope_spec_item" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "hope_spec_item_read" ON "hope_spec_item" FOR SELECT TO wardenx_app USING (true);
GRANT SELECT ON "hope_spec_item" TO wardenx_app;
GRANT ALL ON "hope_spec_item" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "hope_spec_item_isc" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "hope_spec_item_isc_read" ON "hope_spec_item_isc" FOR SELECT TO wardenx_app USING (true);
GRANT SELECT ON "hope_spec_item_isc" TO wardenx_app;
GRANT ALL ON "hope_spec_item_isc" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "hope_spec_item_option" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "hope_spec_item_option_read" ON "hope_spec_item_option" FOR SELECT TO wardenx_app USING (true);
GRANT SELECT ON "hope_spec_item_option" TO wardenx_app;
GRANT ALL ON "hope_spec_item_option" TO wardenx_admin;--> statement-breakpoint

ALTER TABLE "hope_assessment_answer" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "hope_assessment_answer_org" ON "hope_assessment_answer"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "hope_assessment_answer" TO wardenx_app;
GRANT ALL ON "hope_assessment_answer" TO wardenx_admin;--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_hope_assessment_answer() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['value', 'source_reference']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['value', 'source_reference']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'hope_assessment_answer.' || lower(TG_OP),
    'hope_assessment_answer',
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
ALTER FUNCTION audit_phi_write_hope_assessment_answer() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_hope_assessment_answer" AFTER INSERT OR UPDATE OR DELETE ON hope_assessment_answer
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_hope_assessment_answer();
