CREATE TYPE "public"."hope_assessment_status" AS ENUM('draft', 'signed', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."hope_discharge_reason" AS ENUM('death', 'revocation', 'transfer_to_hospice', 'live_discharge');--> statement-breakpoint
CREATE TYPE "public"."hope_rfa_kind" AS ENUM('01_admission', '02_huv1', '03_huv2', '04_sfv', '05_discharge');--> statement-breakpoint
CREATE TYPE "public"."hope_schedule_generated_by" AS ENUM('auto_admission', 'auto_discharge', 'sfv_trigger', 'manual_admin');--> statement-breakpoint
CREATE TYPE "public"."hope_schedule_status" AS ENUM('open', 'completed', 'expired', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."hope_sfv_status" AS ENUM('open', 'completed', 'overdue', 'missed');--> statement-breakpoint
CREATE TYPE "public"."hope_submission_item_status" AS ENUM('accepted', 'rejected', 'pending');--> statement-breakpoint
CREATE TYPE "public"."hope_submission_status" AS ENUM('queued', 'in_flight', 'accepted', 'rejected', 'partially_accepted');--> statement-breakpoint
CREATE TYPE "public"."hope_validation_severity" AS ENUM('error', 'warning');--> statement-breakpoint
CREATE TYPE "public"."j2051_severity" AS ENUM('none', 'mild', 'moderate', 'severe');--> statement-breakpoint
CREATE TABLE "hope_timepoint_schedule" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"admission_id" uuid NOT NULL,
	"rfa_kind" "hope_rfa_kind" NOT NULL,
	"window_opens_at" timestamp with time zone NOT NULL,
	"window_closes_at" timestamp with time zone NOT NULL,
	"late_deadline_at" timestamp with time zone NOT NULL,
	"alert_cadence" jsonb NOT NULL,
	"status" "hope_schedule_status" DEFAULT 'open' NOT NULL,
	"completed_by_assessment_id" uuid,
	"generated_by" "hope_schedule_generated_by" NOT NULL,
	"skip_reason_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hope_assessment" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"admission_id" uuid NOT NULL,
	"schedule_id" uuid,
	"source_encounter_id" uuid,
	"rfa_kind" "hope_rfa_kind" NOT NULL,
	"discharge_reason" "hope_discharge_reason",
	"status" "hope_assessment_status" DEFAULT 'draft' NOT NULL,
	"data" jsonb NOT NULL,
	"j2051_max_severity" "j2051_severity" DEFAULT 'none' NOT NULL,
	"j2051_trigger_fired" boolean DEFAULT false NOT NULL,
	"was_late" boolean DEFAULT false NOT NULL,
	"late_completion_reason_code" text,
	"clinical_context_snapshot" jsonb,
	"corrects_assessment_id" uuid,
	"superseded_by_id" uuid,
	"iqies_record_id" text,
	"target_date" timestamp with time zone NOT NULL,
	"signed_at" timestamp with time zone,
	"signed_by_membership_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_membership_id" uuid NOT NULL,
	CONSTRAINT "hope_assessment_id_target_date_pk" PRIMARY KEY("id","target_date")
);
--> statement-breakpoint
CREATE TABLE "symptom_follow_up_visit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"admission_id" uuid NOT NULL,
	"triggering_assessment_id" uuid NOT NULL,
	"completing_assessment_id" uuid,
	"triggered_at" timestamp with time zone NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"status" "hope_sfv_status" DEFAULT 'open' NOT NULL,
	"alert_cadence" jsonb NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hope_validation_finding" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"hope_assessment_id" uuid NOT NULL,
	"rule_id" text NOT NULL,
	"severity" "hope_validation_severity" NOT NULL,
	"section" text NOT NULL,
	"item_code" text,
	"message" text NOT NULL,
	"evaluated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved" boolean DEFAULT false NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "hope_submission" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"submission_period" text NOT NULL,
	"status" "hope_submission_status" DEFAULT 'queued' NOT NULL,
	"iqies_batch_id" text,
	"envelope_storage_uri" text NOT NULL,
	"envelope_sha256" text NOT NULL,
	"item_count" integer NOT NULL,
	"accepted_count" integer DEFAULT 0 NOT NULL,
	"rejected_count" integer DEFAULT 0 NOT NULL,
	"transmitted_at" timestamp with time zone,
	"accepted_at" timestamp with time zone,
	"acceptance_report" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hope_submission_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"hope_submission_id" uuid NOT NULL,
	"hope_assessment_id" uuid NOT NULL,
	"item_status" "hope_submission_item_status" DEFAULT 'pending' NOT NULL,
	"iqies_record_id" text,
	"iqies_validation_result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "hope_timepoint_schedule" ADD CONSTRAINT "hope_timepoint_schedule_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hope_timepoint_schedule" ADD CONSTRAINT "hope_timepoint_schedule_provider_entity_id_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hope_timepoint_schedule" ADD CONSTRAINT "hope_timepoint_schedule_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hope_assessment" ADD CONSTRAINT "hope_assessment_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hope_assessment" ADD CONSTRAINT "hope_assessment_provider_entity_id_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hope_assessment" ADD CONSTRAINT "hope_assessment_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hope_assessment" ADD CONSTRAINT "hope_assessment_schedule_id_hope_timepoint_schedule_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."hope_timepoint_schedule"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hope_assessment" ADD CONSTRAINT "hope_assessment_signed_by_membership_id_membership_id_fk" FOREIGN KEY ("signed_by_membership_id") REFERENCES "public"."membership"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hope_assessment" ADD CONSTRAINT "hope_assessment_created_by_membership_id_membership_id_fk" FOREIGN KEY ("created_by_membership_id") REFERENCES "public"."membership"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "symptom_follow_up_visit" ADD CONSTRAINT "symptom_follow_up_visit_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "symptom_follow_up_visit" ADD CONSTRAINT "symptom_follow_up_visit_provider_entity_id_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "symptom_follow_up_visit" ADD CONSTRAINT "symptom_follow_up_visit_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hope_validation_finding" ADD CONSTRAINT "hope_validation_finding_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hope_validation_finding" ADD CONSTRAINT "hope_validation_finding_provider_entity_id_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hope_validation_finding" ADD CONSTRAINT "hope_validation_finding_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hope_submission" ADD CONSTRAINT "hope_submission_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hope_submission" ADD CONSTRAINT "hope_submission_provider_entity_id_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hope_submission_item" ADD CONSTRAINT "hope_submission_item_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hope_submission_item" ADD CONSTRAINT "hope_submission_item_hope_submission_id_hope_submission_id_fk" FOREIGN KEY ("hope_submission_id") REFERENCES "public"."hope_submission"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_hope_sched_by_patient_open" ON "hope_timepoint_schedule" USING btree ("patient_id","status","window_opens_at");--> statement-breakpoint
CREATE INDEX "idx_hope_sched_by_org_window" ON "hope_timepoint_schedule" USING btree ("organization_id","status","window_closes_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_hope_sched_admission_rfa_open" ON "hope_timepoint_schedule" USING btree ("admission_id","rfa_kind") WHERE status = 'open' AND rfa_kind != '04_sfv';--> statement-breakpoint
CREATE INDEX "idx_hope_assess_patient_rfa" ON "hope_assessment" USING btree ("patient_id","rfa_kind","target_date") WHERE status = 'signed';--> statement-breakpoint
CREATE INDEX "idx_hope_assess_org_triggered" ON "hope_assessment" USING btree ("organization_id","j2051_trigger_fired","signed_at") WHERE j2051_trigger_fired = true;--> statement-breakpoint
CREATE INDEX "idx_hope_assess_org_unsubmitted" ON "hope_assessment" USING btree ("organization_id","signed_at") WHERE status = 'signed' AND iqies_record_id IS NULL;--> statement-breakpoint
CREATE INDEX "idx_hope_assess_corrects" ON "hope_assessment" USING btree ("corrects_assessment_id") WHERE corrects_assessment_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_sfv_patient_open" ON "symptom_follow_up_visit" USING btree ("patient_id","status","due_at");--> statement-breakpoint
CREATE INDEX "idx_sfv_org_due_at" ON "symptom_follow_up_visit" USING btree ("organization_id","status","due_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_sfv_per_triggering_assessment" ON "symptom_follow_up_visit" USING btree ("triggering_assessment_id");--> statement-breakpoint
CREATE INDEX "idx_hope_finding_assessment" ON "hope_validation_finding" USING btree ("hope_assessment_id","severity","resolved");--> statement-breakpoint
CREATE INDEX "idx_hope_finding_org_unresolved_error" ON "hope_validation_finding" USING btree ("organization_id","severity","resolved") WHERE severity = 'error' AND resolved = false;--> statement-breakpoint
CREATE INDEX "idx_hope_sub_org_period" ON "hope_submission" USING btree ("organization_id","submission_period","status");--> statement-breakpoint
CREATE INDEX "idx_hope_sub_org_queued" ON "hope_submission" USING btree ("organization_id","status","created_at") WHERE status IN ('queued','in_flight');--> statement-breakpoint
CREATE INDEX "idx_hope_sub_item_submission" ON "hope_submission_item" USING btree ("hope_submission_id","item_status");--> statement-breakpoint
CREATE INDEX "idx_hope_sub_item_assessment" ON "hope_submission_item" USING btree ("hope_assessment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_hope_sub_item_assessment_active" ON "hope_submission_item" USING btree ("hope_assessment_id") WHERE item_status = 'pending';