CREATE TYPE "public"."admission_status" AS ENUM('referred', 'pending', 'notice_of_rights_acknowledged', 'active', 'on_hold', 'discharged', 'bereavement', 'closed');--> statement-breakpoint
CREATE TYPE "public"."compliance_window_kind" AS ENUM('initial_assessment_48h', 'comprehensive_assessment_5d', 'care_plan_5d', 'f2f_recert_30d_prior', 'recert_due_14d', 'recert_due_7d', 'cti_signature_lookahead_14d', 'notice_of_rights', 'concurrent_hospital_admission', 'external_discharge_notice', 'hl7_admission_cancellation');--> statement-breakpoint
CREATE TYPE "public"."compliance_window_severity" AS ENUM('warning', 'alert', 'info');--> statement-breakpoint
CREATE TYPE "public"."compliance_window_status" AS ENUM('open', 'closing_soon', 'overdue', 'closed');--> statement-breakpoint
CREATE TYPE "public"."cti_status" AS ENUM('drafted', 'awaiting_hospice_md', 'awaiting_attending', 'signed', 'voided', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."discharge_type" AS ENUM('death', 'revocation', 'transfer', 'no_longer_terminal', 'moved_out_of_service_area', 'for_cause');--> statement-breakpoint
CREATE TYPE "public"."election_period_completion_cause" AS ENUM('next_period', 'revocation', 'transfer', 'discharge');--> statement-breakpoint
CREATE TYPE "public"."election_period_kind" AS ENUM('ninety_day', 'sixty_day');--> statement-breakpoint
CREATE TYPE "public"."election_period_status" AS ENUM('pending', 'signed', 'active', 'completed');--> statement-breakpoint
CREATE TYPE "public"."election_signature_method" AS ENUM('wet_ink_scanned', 'electronic_witnessed');--> statement-breakpoint
CREATE TYPE "public"."election_signer_kind" AS ENUM('patient', 'representative');--> statement-breakpoint
CREATE TYPE "public"."f2f_encounter_location" AS ENUM('patient_home', 'alf', 'snf', 'ipu', 'hospital', 'telehealth');--> statement-breakpoint
CREATE TYPE "public"."f2f_encounter_status" AS ENUM('scheduled', 'completed', 'attested');--> statement-breakpoint
CREATE TYPE "public"."f2f_performer_role" AS ENUM('hospice_md', 'hospice_np');--> statement-breakpoint
CREATE TYPE "public"."level_of_care" AS ENUM('routine_home_care', 'continuous_home_care', 'inpatient_respite_care', 'general_inpatient_care');--> statement-breakpoint
CREATE TYPE "public"."nor_acknowledgment_method" AS ENUM('wet_ink_scanned', 'electronic_witnessed', 'verbal_with_witness');--> statement-breakpoint
CREATE TYPE "public"."referral_source_channel" AS ENUM('phone', 'fax', 'portal', 'walk_in', 'self_referral', 'physician_office', 'hospital_discharge_planner');--> statement-breakpoint
CREATE TYPE "public"."referral_status" AS ENUM('received', 'evaluated', 'accepted', 'rejected', 'withdrawn', 'admitted');--> statement-breakpoint
CREATE TYPE "public"."revocation_reason" AS ENUM('seek_curative_treatment', 'dissatisfaction', 'transferred_out', 'other');--> statement-breakpoint
CREATE TYPE "public"."transfer_direction" AS ENUM('in', 'out');--> statement-breakpoint
CREATE TABLE "referral" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid,
	"location_id" uuid,
	"patient_id" uuid,
	"referral_source_id" uuid,
	"referrer_name" text,
	"referrer_phone" text,
	"patient_name_at_receipt" text NOT NULL,
	"patient_dob_at_receipt" date,
	"referring_dx_text" text,
	"icd10_terminal_primary" text,
	"source_channel" "referral_source_channel" NOT NULL,
	"status" "referral_status" DEFAULT 'received' NOT NULL,
	"rejection_reason" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"evaluated_at" timestamp with time zone,
	"evaluated_by" uuid,
	"decided_at" timestamp with time zone,
	"external_message_ref" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admission" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"referral_id" uuid,
	"status" "admission_status" DEFAULT 'referred' NOT NULL,
	"admission_at" timestamp with time zone,
	"activated_at" timestamp with time zone,
	"hold_at" timestamp with time zone,
	"released_at" timestamp with time zone,
	"hold_reason" text,
	"discharged_at" timestamp with time zone,
	"admitted_by_physician_id" uuid NOT NULL,
	"attending_physician_id" uuid,
	"primary_caregiver_id" uuid,
	"transferred_in" boolean DEFAULT false NOT NULL,
	"transferred_in_from_ccn" text,
	"inherited_period_sequence" smallint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "election_period" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"admission_id" uuid NOT NULL,
	"sequence_number" smallint NOT NULL,
	"period_kind" "election_period_kind" NOT NULL,
	"effective_at" date,
	"scheduled_end_at" date,
	"actual_end_at" date,
	"status" "election_period_status" DEFAULT 'pending' NOT NULL,
	"election_statement_id" uuid,
	"cti_id" uuid,
	"completed_by_cause" "election_period_completion_cause",
	"completed_by_event_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "election_statement" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid,
	"location_id" uuid,
	"election_period_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"signer_kind" "election_signer_kind" NOT NULL,
	"representative_consent_id" uuid,
	"representative_relationship" text,
	"patient_name_at_signing" text NOT NULL,
	"hospice_name_at_signing" text NOT NULL,
	"attending_physician_id" uuid,
	"curative_care_acknowledgment" boolean NOT NULL,
	"signed_at" date NOT NULL,
	"signature_method" "election_signature_method" NOT NULL,
	"document_id" uuid,
	"state_addendum" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "certification_of_terminal_illness" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"election_period_id" uuid NOT NULL,
	"hospice_md_id" uuid NOT NULL,
	"hospice_md_signed_at" timestamp with time zone,
	"attending_md_id" uuid,
	"attending_md_signed_at" timestamp with time zone,
	"terminal_diagnosis_icd10" text NOT NULL,
	"related_conditions_icd10" text[] DEFAULT '{}' NOT NULL,
	"narrative" text NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"signed_late" boolean DEFAULT false NOT NULL,
	"late_reason" text,
	"status" "cti_status" DEFAULT 'drafted' NOT NULL,
	"document_id" uuid,
	"voided_supersedes_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "face_to_face_encounter" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid,
	"location_id" uuid,
	"election_period_id" uuid NOT NULL,
	"performed_by_user_id" uuid NOT NULL,
	"performer_role" "f2f_performer_role" NOT NULL,
	"encounter_date" date,
	"encounter_location" "f2f_encounter_location",
	"within_window" boolean,
	"window_override" boolean DEFAULT false NOT NULL,
	"window_override_reason" text,
	"window_override_by" uuid,
	"attestation_signed_at" timestamp with time zone,
	"attestation_narrative" text,
	"encounter_id" uuid,
	"document_id" uuid,
	"status" "f2f_encounter_status" DEFAULT 'scheduled' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "level_of_care_period" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"admission_id" uuid NOT NULL,
	"level_of_care" "level_of_care" NOT NULL,
	"effective_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"assigned_by" uuid NOT NULL,
	"reason" text NOT NULL,
	"q_code" text NOT NULL,
	"facility_id" uuid,
	"ipu_bed_assignment_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "revocation_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"admission_id" uuid NOT NULL,
	"election_period_id" uuid NOT NULL,
	"signer_kind" "election_signer_kind" NOT NULL,
	"representative_consent_id" uuid,
	"effective_at" date NOT NULL,
	"signed_at" date NOT NULL,
	"revocation_reason" "revocation_reason" NOT NULL,
	"narrative" text,
	"document_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transfer_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"admission_id" uuid NOT NULL,
	"direction" "transfer_direction" NOT NULL,
	"receiving_or_sending_ccn" text NOT NULL,
	"receiving_or_sending_name" text NOT NULL,
	"receiving_or_sending_facility_id" uuid,
	"effective_at" date NOT NULL,
	"period_sequence_at_transfer" smallint NOT NULL,
	"narrative" text,
	"document_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "discharge_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"admission_id" uuid NOT NULL,
	"discharge_type" "discharge_type" NOT NULL,
	"effective_at" date NOT NULL,
	"death_at" timestamp with time zone,
	"death_certifier_id" uuid,
	"for_cause_reason" text,
	"narrative" text,
	"document_id" uuid,
	"bereavement_eligible" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notice_of_rights_acknowledgment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid,
	"location_id" uuid,
	"admission_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"signer_kind" "election_signer_kind" NOT NULL,
	"representative_consent_id" uuid,
	"acknowledged_at" date NOT NULL,
	"acknowledgment_method" "nor_acknowledgment_method" NOT NULL,
	"witness_user_id" uuid,
	"document_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "compliance_window" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"admission_id" uuid NOT NULL,
	"window_kind" "compliance_window_kind" NOT NULL,
	"severity" "compliance_window_severity" DEFAULT 'warning' NOT NULL,
	"auto_acknowledge" boolean DEFAULT false NOT NULL,
	"payload" jsonb,
	"starts_at" timestamp with time zone NOT NULL,
	"must_complete_by" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	"close_reason" text,
	"closed_by" uuid,
	"override_reason" text,
	"status" "compliance_window_status" DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "referral" ADD CONSTRAINT "referral_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral" ADD CONSTRAINT "referral_provider_entity_id_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral" ADD CONSTRAINT "referral_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral" ADD CONSTRAINT "referral_evaluated_by_user_id_fk" FOREIGN KEY ("evaluated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admission" ADD CONSTRAINT "admission_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admission" ADD CONSTRAINT "admission_provider_entity_id_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admission" ADD CONSTRAINT "admission_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admission" ADD CONSTRAINT "admission_referral_id_referral_id_fk" FOREIGN KEY ("referral_id") REFERENCES "public"."referral"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "election_period" ADD CONSTRAINT "election_period_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "election_period" ADD CONSTRAINT "election_period_admission_id_admission_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."admission"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "election_statement" ADD CONSTRAINT "election_statement_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "election_statement" ADD CONSTRAINT "election_statement_provider_entity_id_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "election_statement" ADD CONSTRAINT "election_statement_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "election_statement" ADD CONSTRAINT "election_statement_election_period_id_election_period_id_fk" FOREIGN KEY ("election_period_id") REFERENCES "public"."election_period"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "certification_of_terminal_illness" ADD CONSTRAINT "certification_of_terminal_illness_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "certification_of_terminal_illness" ADD CONSTRAINT "certification_of_terminal_illness_election_period_id_election_period_id_fk" FOREIGN KEY ("election_period_id") REFERENCES "public"."election_period"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "face_to_face_encounter" ADD CONSTRAINT "face_to_face_encounter_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "face_to_face_encounter" ADD CONSTRAINT "face_to_face_encounter_provider_entity_id_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "face_to_face_encounter" ADD CONSTRAINT "face_to_face_encounter_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "face_to_face_encounter" ADD CONSTRAINT "face_to_face_encounter_election_period_id_election_period_id_fk" FOREIGN KEY ("election_period_id") REFERENCES "public"."election_period"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "face_to_face_encounter" ADD CONSTRAINT "face_to_face_encounter_performed_by_user_id_user_id_fk" FOREIGN KEY ("performed_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "face_to_face_encounter" ADD CONSTRAINT "face_to_face_encounter_window_override_by_user_id_fk" FOREIGN KEY ("window_override_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "level_of_care_period" ADD CONSTRAINT "level_of_care_period_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "level_of_care_period" ADD CONSTRAINT "level_of_care_period_admission_id_admission_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."admission"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "level_of_care_period" ADD CONSTRAINT "level_of_care_period_assigned_by_user_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revocation_event" ADD CONSTRAINT "revocation_event_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revocation_event" ADD CONSTRAINT "revocation_event_admission_id_admission_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."admission"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revocation_event" ADD CONSTRAINT "revocation_event_election_period_id_election_period_id_fk" FOREIGN KEY ("election_period_id") REFERENCES "public"."election_period"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfer_event" ADD CONSTRAINT "transfer_event_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfer_event" ADD CONSTRAINT "transfer_event_admission_id_admission_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."admission"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discharge_event" ADD CONSTRAINT "discharge_event_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discharge_event" ADD CONSTRAINT "discharge_event_admission_id_admission_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."admission"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notice_of_rights_acknowledgment" ADD CONSTRAINT "notice_of_rights_acknowledgment_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notice_of_rights_acknowledgment" ADD CONSTRAINT "notice_of_rights_acknowledgment_provider_entity_id_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notice_of_rights_acknowledgment" ADD CONSTRAINT "notice_of_rights_acknowledgment_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notice_of_rights_acknowledgment" ADD CONSTRAINT "notice_of_rights_acknowledgment_admission_id_admission_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."admission"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notice_of_rights_acknowledgment" ADD CONSTRAINT "notice_of_rights_acknowledgment_witness_user_id_user_id_fk" FOREIGN KEY ("witness_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_window" ADD CONSTRAINT "compliance_window_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_window" ADD CONSTRAINT "compliance_window_admission_id_admission_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."admission"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_window" ADD CONSTRAINT "compliance_window_closed_by_user_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "referral_org_status_received_idx" ON "referral" USING btree ("organization_id","status","received_at");--> statement-breakpoint
CREATE INDEX "referral_patient_idx" ON "referral" USING btree ("patient_id");--> statement-breakpoint
CREATE UNIQUE INDEX "admission_patient_open_idx" ON "admission" USING btree ("organization_id","patient_id") WHERE status NOT IN ('discharged','bereavement','closed');--> statement-breakpoint
CREATE INDEX "admission_org_status_idx" ON "admission" USING btree ("organization_id","status","admission_at");--> statement-breakpoint
CREATE INDEX "admission_pe_status_idx" ON "admission" USING btree ("provider_entity_id","status");--> statement-breakpoint
CREATE INDEX "admission_attending_idx" ON "admission" USING btree ("attending_physician_id");--> statement-breakpoint
CREATE UNIQUE INDEX "election_period_admission_seq_idx" ON "election_period" USING btree ("admission_id","sequence_number");--> statement-breakpoint
CREATE INDEX "election_period_admission_idx" ON "election_period" USING btree ("admission_id","sequence_number");--> statement-breakpoint
CREATE UNIQUE INDEX "election_statement_period_idx" ON "election_statement" USING btree ("election_period_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cti_period_active_idx" ON "certification_of_terminal_illness" USING btree ("election_period_id") WHERE status <> 'voided';--> statement-breakpoint
CREATE INDEX "cti_org_status_idx" ON "certification_of_terminal_illness" USING btree ("organization_id","status","period_start");--> statement-breakpoint
CREATE UNIQUE INDEX "f2f_period_attested_idx" ON "face_to_face_encounter" USING btree ("election_period_id") WHERE status = 'attested';--> statement-breakpoint
CREATE INDEX "f2f_performer_date_idx" ON "face_to_face_encounter" USING btree ("performed_by_user_id","encounter_date");--> statement-breakpoint
CREATE INDEX "f2f_org_period_idx" ON "face_to_face_encounter" USING btree ("organization_id","election_period_id");--> statement-breakpoint
CREATE INDEX "lcp_adm_effective_idx" ON "level_of_care_period" USING btree ("admission_id","effective_at");--> statement-breakpoint
CREATE UNIQUE INDEX "lcp_adm_open_idx" ON "level_of_care_period" USING btree ("admission_id") WHERE ended_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "revocation_period_idx" ON "revocation_event" USING btree ("election_period_id");--> statement-breakpoint
CREATE INDEX "transfer_org_eff_idx" ON "transfer_event" USING btree ("organization_id","effective_at");--> statement-breakpoint
CREATE UNIQUE INDEX "discharge_admission_idx" ON "discharge_event" USING btree ("admission_id");--> statement-breakpoint
CREATE UNIQUE INDEX "nor_admission_idx" ON "notice_of_rights_acknowledgment" USING btree ("admission_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cw_adm_kind_open_idx" ON "compliance_window" USING btree ("admission_id","window_kind") WHERE status <> 'closed';--> statement-breakpoint
CREATE INDEX "cw_org_due_idx" ON "compliance_window" USING btree ("organization_id","status","must_complete_by") WHERE status <> 'closed';--> statement-breakpoint
CREATE INDEX "cw_adm_kind_idx" ON "compliance_window" USING btree ("admission_id","window_kind");
