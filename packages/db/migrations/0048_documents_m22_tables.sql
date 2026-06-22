CREATE TYPE "public"."chart_target_module" AS ENUM('m5', 'm7', 'm9', 'm11', 'm12', 'm13', 'm22', 'm40');--> statement-breakpoint
CREATE TYPE "public"."classified_page_doc_type" AS ENUM('discharge_summary', 'med_recon', 'hp', 'lab', 'imaging', 'consult', 'insurance_card', 'photo_id', 'advance_directive', 'dpoa', 'transfer_record', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."document_access_kind" AS ENUM('metadata_read', 'content_download', 'signed_url_issued', 'signed_url_consumed', 'portal_view', 'disclosure_export');--> statement-breakpoint
CREATE TYPE "public"."document_access_purpose" AS ENUM('treatment', 'payment', 'operations', 'disclosure', 'patient_access', 'amendment_review', 'survey_export');--> statement-breakpoint
CREATE TYPE "public"."document_aggregate_type" AS ENUM('election_statement', 'cti', 'f2f', 'nor', 'revocation', 'discharge_summary', 'nomnc', 'abn', 'hipaa_privacy_notice', 'code_status_directive', 'encounter', 'order_record', 'medication_order', 'medication_administration_record', 'medication_reconciliation_worksheet', 'patient_medication_list', 'comfort_kit_receipt', 'idg_patient_packet', 'idg_minutes', 'aide_poc', 'msw_plan', 'spiritual_plan', 'volunteer_plan', 'bereavement_letter', 'visit_confirmation', 'evv_verification', 'patient_amendment_statement_of_disagreement', 'consent_record', 'intake_source', 'other');--> statement-breakpoint
CREATE TYPE "public"."document_retention_class" AS ENUM('compliance', 'clinical_record', 'bereavement', 'operational', 'intake_artifact', 'compliance_42cfr_part2');--> statement-breakpoint
CREATE TYPE "public"."document_source_kind" AS ENUM('form_render', 'user_upload', 'api_ingest', 'fax_ingest', 'portal_upload', 'extraction_writeback', 'consent_capture');--> statement-breakpoint
CREATE TYPE "public"."document_status" AS ENUM('active', 'superseded', 'legal_hold', 'destroyed_tombstone');--> statement-breakpoint
CREATE TYPE "public"."extraction_candidate_code_system" AS ENUM('rxnorm', 'icd10', 'loinc', 'snomed', 'ndc', 'none');--> statement-breakpoint
CREATE TYPE "public"."extraction_candidate_field_kind" AS ENUM('text', 'code', 'date', 'boolean', 'measurement', 'enum');--> statement-breakpoint
CREATE TYPE "public"."extraction_candidate_risk_level" AS ENUM('low', 'medium', 'high');--> statement-breakpoint
CREATE TYPE "public"."extraction_decision_kind" AS ENUM('approve', 'approve_with_edit', 'reject');--> statement-breakpoint
CREATE TYPE "public"."extraction_discrepancy_kind" AS ENUM('cross_source', 'chart_existing');--> statement-breakpoint
CREATE TYPE "public"."extraction_discrepancy_status" AS ENUM('open', 'resolved');--> statement-breakpoint
CREATE TYPE "public"."extraction_job_status" AS ENUM('queued', 'extracting', 'verifying', 'discrepancy_check', 'ready_for_review', 'in_review', 'committed', 'discarded', 'failed', 'awaiting_capability', 'stalled');--> statement-breakpoint
CREATE TYPE "public"."extraction_review_status" AS ENUM('in_progress', 'complete', 'abandoned');--> statement-breakpoint
CREATE TYPE "public"."form_fill_status" AS ENUM('queued', 'rendering', 'rendered', 'failed', 'delivered');--> statement-breakpoint
CREATE TYPE "public"."form_render_engine" AS ENUM('react_pdf', 'puppeteer');--> statement-breakpoint
CREATE TYPE "public"."intake_batch_status" AS ENUM('uploaded', 'docling_complete', 'classifier_complete', 'extraction_complete', 'in_review', 'writeback_complete', 'discarded', 'split_into_children', 'split_resolved_no_split', 'parse_failed');--> statement-breakpoint
CREATE TABLE "document" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid,
	"location_id" uuid,
	"patient_id" uuid,
	"admission_id" uuid,
	"retention_class" "document_retention_class" NOT NULL,
	"source_kind" "document_source_kind" NOT NULL,
	"aggregate_type" "document_aggregate_type" NOT NULL,
	"aggregate_id" uuid,
	"title" text NOT NULL,
	"patient_facing" boolean DEFAULT false NOT NULL,
	"attach_to_disclosures" boolean DEFAULT false NOT NULL,
	"disclosure_restricted" boolean DEFAULT false NOT NULL,
	"metadata" jsonb,
	"status" "document_status" DEFAULT 'active' NOT NULL,
	"active_version_id" uuid,
	"created_by_membership_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_version" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"version_number" text NOT NULL,
	"replaces_version_id" uuid,
	"minio_object_key" text NOT NULL,
	"mime_type" text NOT NULL,
	"byte_size" text NOT NULL,
	"sha256_hex" text NOT NULL,
	"sha256_verified_at" timestamp with time zone,
	"byte_payload_cipher" text,
	"uploaded_by_membership_id" uuid,
	"uploaded_by_kind" text NOT NULL,
	"render_form_fill_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_version_uploader_shape" CHECK ((uploaded_by_kind = 'user') = (uploaded_by_membership_id IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "document_tag" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"tag_kind" text NOT NULL,
	"tag_key" text NOT NULL,
	"tag_value" text,
	"added_by_membership_id" uuid NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_access_log" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"document_version_id" uuid NOT NULL,
	"accessor_membership_id" uuid NOT NULL,
	"access_kind" text NOT NULL,
	"purpose" text NOT NULL,
	"recipient_membership_id" uuid,
	"recipient_class" text,
	"correlation_id" text NOT NULL,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_access_log_id_accessed_at_pk" PRIMARY KEY("id","accessed_at")
);
--> statement-breakpoint
CREATE TABLE "document_legal_hold" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"legal_hold_event_id" uuid NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "form_template" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"template_key" text NOT NULL,
	"aggregate_type" "document_aggregate_type" NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"render_engine" "form_render_engine" NOT NULL,
	"retention_class" "document_retention_class" NOT NULL,
	"patient_facing" boolean DEFAULT false NOT NULL,
	"published_active_version_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "form_template_version" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"template_id" uuid NOT NULL,
	"version_label" text NOT NULL,
	"source_path" text NOT NULL,
	"payload_schema" jsonb NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"published_by_membership_id" uuid,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant_template_overlay" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"template_id" uuid NOT NULL,
	"branding" jsonb NOT NULL,
	"state_addendum" jsonb,
	"is_active" boolean DEFAULT true NOT NULL,
	"published_by_membership_id" uuid NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "form_fill" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"template_version_id" uuid NOT NULL,
	"tenant_overlay_id" uuid,
	"aggregate_type" "document_aggregate_type" NOT NULL,
	"aggregate_id" uuid NOT NULL,
	"render_payload" jsonb NOT NULL,
	"status" "form_fill_status" DEFAULT 'queued' NOT NULL,
	"result_document_id" uuid,
	"failure_reason" text,
	"render_attempts" text DEFAULT '0' NOT NULL,
	"correlation_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rendered_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	CONSTRAINT "form_fill_id_created_at_pk" PRIMARY KEY("id","created_at")
);
--> statement-breakpoint
CREATE TABLE "intake_upload_batch" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid,
	"location_id" uuid,
	"patient_id" uuid,
	"initial_document_id" uuid NOT NULL,
	"source_channel" text NOT NULL,
	"source_metadata" text,
	"status" "intake_batch_status" DEFAULT 'uploaded' NOT NULL,
	"child_batch_ids" jsonb,
	"audit_metadata" jsonb,
	"uploaded_by_membership_id" uuid NOT NULL,
	"correlation_id" text NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disposition_at" timestamp with time zone,
	CONSTRAINT "intake_upload_batch_disposition_shape" CHECK ((status IN ('writeback_complete','discarded')) = (disposition_at IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "classified_page" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"intake_upload_batch_id" uuid NOT NULL,
	"source_document_id" uuid NOT NULL,
	"page_range_start" integer NOT NULL,
	"page_range_end" integer NOT NULL,
	"document_type" "classified_page_doc_type" NOT NULL,
	"confidence" numeric(4, 3) NOT NULL,
	"human_confirmed" boolean DEFAULT false NOT NULL,
	"human_confirmed_by_membership_id" uuid,
	"human_confirmed_at" timestamp with time zone,
	"classifier_model_version_ref" text NOT NULL,
	"error_class" text,
	"classified_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "classified_page_range_shape" CHECK (page_range_end >= page_range_start),
	CONSTRAINT "classified_page_human_confirm_shape" CHECK ((human_confirmed = true) = (human_confirmed_by_membership_id IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "extraction_job" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"classified_page_id" uuid NOT NULL,
	"document_type" "classified_page_doc_type" NOT NULL,
	"status" "extraction_job_status" DEFAULT 'queued' NOT NULL,
	"extractor_model_version_ref" text NOT NULL,
	"vision_verifier_model_version_ref" text,
	"aggregate_confidence" numeric(4, 3),
	"retry_count" integer DEFAULT 0 NOT NULL,
	"failure_reason" text,
	"correlation_id" text NOT NULL,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "extraction_job_id_queued_at_pk" PRIMARY KEY("id","queued_at")
);
--> statement-breakpoint
CREATE TABLE "extraction_candidate" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"extraction_job_id" uuid NOT NULL,
	"field_path" text NOT NULL,
	"field_kind" "extraction_candidate_field_kind" NOT NULL,
	"risk_level" "extraction_candidate_risk_level" NOT NULL,
	"value_text" text,
	"value_code" text,
	"value_code_system" "extraction_candidate_code_system" DEFAULT 'none' NOT NULL,
	"value_cipher" text,
	"confidence" numeric(4, 3) NOT NULL,
	"source_page" integer NOT NULL,
	"source_bounding_box" jsonb NOT NULL,
	"vision_verified" boolean DEFAULT false NOT NULL,
	"vision_disagreement" text,
	"sud_detected" boolean DEFAULT false NOT NULL,
	"extracted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "extraction_candidate_id_extracted_at_pk" PRIMARY KEY("id","extracted_at"),
	CONSTRAINT "extraction_candidate_source_bbox_shape" CHECK (source_bounding_box ? 'x1' AND source_bounding_box ? 'y1' AND source_bounding_box ? 'x2' AND source_bounding_box ? 'y2')
);
--> statement-breakpoint
CREATE TABLE "extraction_discrepancy" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"intake_upload_batch_id" uuid NOT NULL,
	"discrepancy_kind" "extraction_discrepancy_kind" NOT NULL,
	"field_path" text NOT NULL,
	"candidate_a_id" uuid NOT NULL,
	"candidate_b_id" uuid,
	"chart_existing_value" text,
	"chart_target_module" chart_target_module,
	"status" "extraction_discrepancy_status" DEFAULT 'open' NOT NULL,
	"resolution" text,
	"resolution_value" text,
	"resolved_by_membership_id" uuid,
	"resolved_at" timestamp with time zone,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "extraction_discrepancy_shape" CHECK ((discrepancy_kind = 'cross_source' AND candidate_b_id IS NOT NULL AND chart_existing_value IS NULL)
        OR (discrepancy_kind = 'chart_existing' AND candidate_b_id IS NULL AND chart_existing_value IS NOT NULL AND chart_target_module IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "extraction_review" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"intake_upload_batch_id" uuid NOT NULL,
	"reviewer_membership_id" uuid NOT NULL,
	"status" "extraction_review_status" DEFAULT 'in_progress' NOT NULL,
	"candidates_total" integer DEFAULT 0 NOT NULL,
	"candidates_decided" integer DEFAULT 0 NOT NULL,
	"correlation_id" text NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "extraction_decision" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"extraction_candidate_id" uuid NOT NULL,
	"extraction_review_id" uuid NOT NULL,
	"decision" "extraction_decision_kind" NOT NULL,
	"edited_value" text,
	"edited_code" text,
	"source_view_confirmed" boolean NOT NULL,
	"chart_overwrite_confirmed" boolean,
	"reason" text,
	"part_of_bulk_approve" boolean DEFAULT false NOT NULL,
	"bulk_approve_batch_id" uuid,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "extraction_provenance" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"extraction_decision_id" uuid NOT NULL,
	"extraction_candidate_id" uuid NOT NULL,
	"source_document_id" uuid NOT NULL,
	"source_document_version_id" uuid NOT NULL,
	"source_page" integer NOT NULL,
	"source_bounding_box" jsonb NOT NULL,
	"classifier_model_version_ref" text NOT NULL,
	"extractor_model_version_ref" text NOT NULL,
	"vision_verifier_model_version_ref" text,
	"target_module" chart_target_module NOT NULL,
	"target_field_path" text NOT NULL,
	"target_aggregate_id" uuid,
	"committed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "document" ADD CONSTRAINT "document_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document" ADD CONSTRAINT "document_provider_entity_id_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document" ADD CONSTRAINT "document_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_version" ADD CONSTRAINT "document_version_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_version" ADD CONSTRAINT "document_version_document_id_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."document"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_tag" ADD CONSTRAINT "document_tag_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_tag" ADD CONSTRAINT "document_tag_document_id_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."document"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_access_log" ADD CONSTRAINT "document_access_log_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_legal_hold" ADD CONSTRAINT "document_legal_hold_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_legal_hold" ADD CONSTRAINT "document_legal_hold_document_id_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."document"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_template_version" ADD CONSTRAINT "form_template_version_template_id_form_template_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."form_template"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_template_overlay" ADD CONSTRAINT "tenant_template_overlay_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_template_overlay" ADD CONSTRAINT "tenant_template_overlay_template_id_form_template_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."form_template"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_fill" ADD CONSTRAINT "form_fill_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_fill" ADD CONSTRAINT "form_fill_template_version_id_form_template_version_id_fk" FOREIGN KEY ("template_version_id") REFERENCES "public"."form_template_version"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_upload_batch" ADD CONSTRAINT "intake_upload_batch_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_upload_batch" ADD CONSTRAINT "intake_upload_batch_provider_entity_id_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_upload_batch" ADD CONSTRAINT "intake_upload_batch_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "classified_page" ADD CONSTRAINT "classified_page_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "classified_page" ADD CONSTRAINT "classified_page_intake_upload_batch_id_intake_upload_batch_id_fk" FOREIGN KEY ("intake_upload_batch_id") REFERENCES "public"."intake_upload_batch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extraction_job" ADD CONSTRAINT "extraction_job_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extraction_job" ADD CONSTRAINT "extraction_job_classified_page_id_classified_page_id_fk" FOREIGN KEY ("classified_page_id") REFERENCES "public"."classified_page"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extraction_candidate" ADD CONSTRAINT "extraction_candidate_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extraction_discrepancy" ADD CONSTRAINT "extraction_discrepancy_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extraction_discrepancy" ADD CONSTRAINT "extraction_discrepancy_intake_upload_batch_id_intake_upload_batch_id_fk" FOREIGN KEY ("intake_upload_batch_id") REFERENCES "public"."intake_upload_batch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extraction_review" ADD CONSTRAINT "extraction_review_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extraction_review" ADD CONSTRAINT "extraction_review_intake_upload_batch_id_intake_upload_batch_id_fk" FOREIGN KEY ("intake_upload_batch_id") REFERENCES "public"."intake_upload_batch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extraction_decision" ADD CONSTRAINT "extraction_decision_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extraction_decision" ADD CONSTRAINT "extraction_decision_extraction_review_id_extraction_review_id_fk" FOREIGN KEY ("extraction_review_id") REFERENCES "public"."extraction_review"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extraction_provenance" ADD CONSTRAINT "extraction_provenance_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extraction_provenance" ADD CONSTRAINT "extraction_provenance_extraction_decision_id_extraction_decision_id_fk" FOREIGN KEY ("extraction_decision_id") REFERENCES "public"."extraction_decision"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_org_patient_idx" ON "document" USING btree ("organization_id","patient_id");--> statement-breakpoint
CREATE INDEX "document_org_aggregate_idx" ON "document" USING btree ("organization_id","aggregate_type","aggregate_id");--> statement-breakpoint
CREATE INDEX "document_retention_idx" ON "document" USING btree ("retention_class","status");--> statement-breakpoint
CREATE INDEX "document_patient_facing_idx" ON "document" USING btree ("organization_id","patient_id") WHERE patient_facing = true;--> statement-breakpoint
CREATE INDEX "document_legal_hold_idx" ON "document" USING btree ("organization_id") WHERE status = 'legal_hold';--> statement-breakpoint
CREATE INDEX "document_attach_disclosures_idx" ON "document" USING btree ("organization_id","patient_id") WHERE attach_to_disclosures = true;--> statement-breakpoint
CREATE UNIQUE INDEX "document_version_doc_version_uk" ON "document_version" USING btree ("document_id","version_number");--> statement-breakpoint
CREATE UNIQUE INDEX "document_version_minio_key_uk" ON "document_version" USING btree ("minio_object_key");--> statement-breakpoint
CREATE INDEX "document_version_sha256_idx" ON "document_version" USING btree ("sha256_hex");--> statement-breakpoint
CREATE INDEX "document_version_org_created_idx" ON "document_version" USING btree ("organization_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "document_tag_doc_idx" ON "document_tag" USING btree ("document_id","tag_key");--> statement-breakpoint
CREATE INDEX "document_tag_org_key_idx" ON "document_tag" USING btree ("organization_id","tag_key","tag_value");--> statement-breakpoint
CREATE INDEX "doc_access_log_doc_idx" ON "document_access_log" USING btree ("document_id","accessed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "doc_access_log_accessor_idx" ON "document_access_log" USING btree ("organization_id","accessor_membership_id","accessed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "doc_access_log_purpose_idx" ON "document_access_log" USING btree ("organization_id","purpose","accessed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "doc_legal_hold_active_uk" ON "document_legal_hold" USING btree ("document_id") WHERE released_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "form_template_key_uk" ON "form_template" USING btree ("template_key");--> statement-breakpoint
CREATE UNIQUE INDEX "form_template_version_uk" ON "form_template_version" USING btree ("template_id","version_label");--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_overlay_active_uk" ON "tenant_template_overlay" USING btree ("organization_id","template_id") WHERE is_active = true;--> statement-breakpoint
CREATE INDEX "form_fill_aggregate_idx" ON "form_fill" USING btree ("organization_id","aggregate_type","aggregate_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "form_fill_status_idx" ON "form_fill" USING btree ("status","created_at" DESC NULLS LAST) WHERE status IN ('queued','rendering','failed');--> statement-breakpoint
CREATE INDEX "intake_batch_org_patient_idx" ON "intake_upload_batch" USING btree ("organization_id","patient_id");--> statement-breakpoint
CREATE INDEX "intake_batch_pending_review_idx" ON "intake_upload_batch" USING btree ("organization_id") WHERE status IN ('extraction_complete','in_review');--> statement-breakpoint
CREATE INDEX "classified_page_batch_idx" ON "classified_page" USING btree ("intake_upload_batch_id","page_range_start");--> statement-breakpoint
CREATE INDEX "extraction_job_status_idx" ON "extraction_job" USING btree ("status","queued_at");--> statement-breakpoint
CREATE INDEX "extraction_job_classified_page_idx" ON "extraction_job" USING btree ("classified_page_id");--> statement-breakpoint
CREATE INDEX "extraction_candidate_job_field_idx" ON "extraction_candidate" USING btree ("extraction_job_id","field_path");--> statement-breakpoint
CREATE INDEX "extraction_candidate_risk_idx" ON "extraction_candidate" USING btree ("risk_level","confidence" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "extraction_discrepancy_batch_idx" ON "extraction_discrepancy" USING btree ("intake_upload_batch_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "extraction_review_in_progress_uk" ON "extraction_review" USING btree ("intake_upload_batch_id") WHERE status = 'in_progress';--> statement-breakpoint
CREATE UNIQUE INDEX "extraction_decision_per_candidate_uk" ON "extraction_decision" USING btree ("extraction_candidate_id","extraction_review_id");--> statement-breakpoint
CREATE UNIQUE INDEX "extraction_provenance_decision_uk" ON "extraction_provenance" USING btree ("extraction_decision_id");--> statement-breakpoint
CREATE INDEX "extraction_provenance_target_idx" ON "extraction_provenance" USING btree ("target_module","target_aggregate_id");--> statement-breakpoint
CREATE INDEX "extraction_provenance_source_idx" ON "extraction_provenance" USING btree ("source_document_id");