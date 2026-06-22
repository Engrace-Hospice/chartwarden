CREATE TYPE "public"."assessment_acting_as" AS ENUM('self', 'patient_representative');--> statement-breakpoint
CREATE TYPE "public"."assessment_status" AS ENUM('active', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."scale_license_status" AS ENUM('active', 'pending_renewal', 'expired');--> statement-breakpoint
CREATE TYPE "public"."scale_type" AS ENUM('pps', 'kps', 'fast', 'painad', 'flacc', 'esas_r', 'nyha', 'meld', 'bode', 'flacker', 'gds', 'braden', 'morse', 'aims');--> statement-breakpoint
CREATE TYPE "public"."significant_change_rule_id" AS ENUM('pps_drop_20_in_14d', 'kps_drop_20_in_14d', 'esas_total_increase_20_in_7d', 'esas_symptom_ge_7', 'painad_ge_4', 'nyha_class_iv', 'braden_le_12', 'morse_ge_51', 'meld_ge_30', 'fast_progression_30d', 'gds_progression_30d', 'flacker_increase', 'aims_emergent_dyskinesia');--> statement-breakpoint
CREATE TYPE "public"."significant_change_status" AS ENUM('open', 'acknowledged', 'escalated');--> statement-breakpoint
CREATE TABLE "clinical_assessment" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"admission_id" uuid NOT NULL,
	"scale_type" "scale_type" NOT NULL,
	"scale_version" text NOT NULL,
	"data" jsonb NOT NULL,
	"score" numeric(8, 2),
	"score_interpretation" text,
	"captured_at" timestamp with time zone NOT NULL,
	"captured_by_membership_id" uuid NOT NULL,
	"captured_by_discipline" text NOT NULL,
	"source_encounter_id" uuid,
	"cosign_required" boolean DEFAULT false NOT NULL,
	"sud_context" boolean DEFAULT false NOT NULL,
	"acting_consent_id" uuid,
	"acting_as" "assessment_acting_as" DEFAULT 'self' NOT NULL,
	"status" "assessment_status" DEFAULT 'active' NOT NULL,
	"corrects_assessment_id" uuid,
	"correction_reason" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clinical_assessment_id_captured_at_pk" PRIMARY KEY("id","captured_at"),
	CONSTRAINT "correction_consistency" CHECK ((corrects_assessment_id IS NULL AND correction_reason IS NULL)
          OR (corrects_assessment_id IS NOT NULL AND correction_reason IS NOT NULL
              AND char_length(correction_reason) >= 10))
);
--> statement-breakpoint
CREATE TABLE "assessment_cosignature" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"clinical_assessment_id" uuid NOT NULL,
	"cosigner_membership_id" uuid NOT NULL,
	"cosigner_role" text NOT NULL,
	"cosigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attestation_text" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "significant_change_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"clinical_assessment_id" uuid NOT NULL,
	"prior_assessment_id" uuid,
	"rule_id" "significant_change_rule_id" NOT NULL,
	"delta_value" numeric(8, 2),
	"threshold_value" numeric(8, 2),
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" "significant_change_status" DEFAULT 'open' NOT NULL,
	"acknowledged_by_membership_id" uuid,
	"acknowledged_at" timestamp with time zone,
	"acknowledgment_note" text,
	"escalated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "scale_license" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"scale_type" "scale_type" NOT NULL,
	"license_holder" text NOT NULL,
	"license_number" text,
	"effective_date" date NOT NULL,
	"expires_at" date NOT NULL,
	"status" "scale_license_status" DEFAULT 'active' NOT NULL,
	"recorded_by_membership_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scale_policy" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"scale_type" "scale_type" NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"significant_change_overrides" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"reassessment_cadence_overrides" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_membership_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "clinical_assessment" ADD CONSTRAINT "clinical_assessment_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_assessment" ADD CONSTRAINT "clinical_assessment_provider_entity_id_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_assessment" ADD CONSTRAINT "clinical_assessment_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_assessment" ADD CONSTRAINT "clinical_assessment_captured_by_membership_id_membership_id_fk" FOREIGN KEY ("captured_by_membership_id") REFERENCES "public"."membership"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_cosignature" ADD CONSTRAINT "assessment_cosignature_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_cosignature" ADD CONSTRAINT "assessment_cosignature_provider_entity_id_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_cosignature" ADD CONSTRAINT "assessment_cosignature_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_cosignature" ADD CONSTRAINT "assessment_cosignature_cosigner_membership_id_membership_id_fk" FOREIGN KEY ("cosigner_membership_id") REFERENCES "public"."membership"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "significant_change_event" ADD CONSTRAINT "significant_change_event_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "significant_change_event" ADD CONSTRAINT "significant_change_event_provider_entity_id_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "significant_change_event" ADD CONSTRAINT "significant_change_event_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "significant_change_event" ADD CONSTRAINT "significant_change_event_acknowledged_by_membership_id_membership_id_fk" FOREIGN KEY ("acknowledged_by_membership_id") REFERENCES "public"."membership"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scale_license" ADD CONSTRAINT "scale_license_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scale_license" ADD CONSTRAINT "scale_license_recorded_by_membership_id_membership_id_fk" FOREIGN KEY ("recorded_by_membership_id") REFERENCES "public"."membership"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scale_policy" ADD CONSTRAINT "scale_policy_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scale_policy" ADD CONSTRAINT "scale_policy_updated_by_membership_id_membership_id_fk" FOREIGN KEY ("updated_by_membership_id") REFERENCES "public"."membership"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "clinical_assessment_patient_scale_captured_idx" ON "clinical_assessment" USING btree ("organization_id","patient_id","scale_type","captured_at" DESC NULLS LAST) WHERE status = 'active';--> statement-breakpoint
CREATE INDEX "clinical_assessment_source_encounter_idx" ON "clinical_assessment" USING btree ("source_encounter_id") WHERE source_encounter_id is not null;--> statement-breakpoint
CREATE INDEX "clinical_assessment_admission_idx" ON "clinical_assessment" USING btree ("organization_id","admission_id","captured_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "assessment_cosignature_assessment_role_uq" ON "assessment_cosignature" USING btree ("clinical_assessment_id","cosigner_role");--> statement-breakpoint
CREATE INDEX "significant_change_open_patient_idx" ON "significant_change_event" USING btree ("organization_id","clinical_assessment_id") WHERE status = 'open';--> statement-breakpoint
CREATE INDEX "significant_change_detected_idx" ON "significant_change_event" USING btree ("detected_at");--> statement-breakpoint
CREATE UNIQUE INDEX "scale_license_active_per_org_scale_uq" ON "scale_license" USING btree ("organization_id","scale_type") WHERE status = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "scale_policy_per_org_scale_uq" ON "scale_policy" USING btree ("organization_id","scale_type");