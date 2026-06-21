CREATE TYPE "public"."assembled_output_kind" AS ENUM('primary_finalize', 'addendum_finalize');--> statement-breakpoint
CREATE TYPE "public"."cosignature_status" AS ENUM('pending', 'routed', 'acknowledged', 'escalated', 'hard_cap_reached', 'supervisor_released', 'signed');--> statement-breakpoint
CREATE TYPE "public"."encounter_discipline" AS ENUM('rn', 'lpn', 'chha', 'msw', 'chaplain', 'volunteer', 'md', 'np');--> statement-breakpoint
CREATE TYPE "public"."encounter_status" AS ENUM('draft', 'finalized', 'signed', 'cosign_pending', 'cosigned', 'voided');--> statement-breakpoint
CREATE TYPE "public"."encounter_type" AS ENUM('routine_visit', 'admission_visit', 'recert_visit', 'face_to_face', 'telephonic', 'lpn_visit', 'chha_visit', 'msw_assessment', 'msw_followup', 'chaplain_assessment', 'chaplain_visit', 'volunteer_visit', 'bereavement_contact', 'idg_followup');--> statement-breakpoint
CREATE TYPE "public"."evv_bracket_state" AS ENUM('evv_present', 'evv_missing_documented');--> statement-breakpoint
CREATE TYPE "public"."late_entry_tier" AS ENUM('normal', 'late_entry', 'significant_late_entry', 'administrative_override');--> statement-breakpoint
CREATE TYPE "public"."layer2_eligibility_reason" AS ENUM('eligible', 'tenant_flag_off', 'clinician_opted_out', 'encounter_type_excluded', 'token_budget_exceeded', 'baa_not_executed', 'routing_preference_blocks_cloud', 'kill_switch_active');--> statement-breakpoint
CREATE TYPE "public"."layer2_passage_decision" AS ENUM('accept', 'edit', 'reject');--> statement-breakpoint
CREATE TYPE "public"."pain_scale" AS ENUM('nrs_0_10', 'flacc', 'painad', 'verbal_descriptor');--> statement-breakpoint
CREATE TYPE "public"."signature_kind" AS ENUM('primary', 'cosignature', 'addendum');--> statement-breakpoint
CREATE TYPE "public"."signature_method" AS ENUM('passkey', 'biometric', 'password_plus_otp');--> statement-breakpoint
CREATE TYPE "public"."vital_unit" AS ENUM('mmHg', 'bpm', 'breaths_per_min', 'c', 'f', 'percent_o2', 'kg', 'lb', 'cm', 'in', 'mg_dl', 'mmol_l');--> statement-breakpoint
CREATE TABLE "encounter" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"admission_id" uuid NOT NULL,
	"visit_id" uuid,
	"encounter_type" "encounter_type" NOT NULL,
	"discipline" "encounter_discipline" NOT NULL,
	"authored_by_membership_id" uuid NOT NULL,
	"service_date" date NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"evv_bracket_state" "evv_bracket_state",
	"evv_check_in_event_id" uuid,
	"evv_check_out_event_id" uuid,
	"evv_missing_reason" text,
	"status" "encounter_status" DEFAULT 'draft' NOT NULL,
	"late_entry_tier" "late_entry_tier" DEFAULT 'normal' NOT NULL,
	"late_entry_reason" text,
	"significant_late_override_by" uuid,
	"significant_late_override_reason" text,
	"administrative_override_by" uuid,
	"administrative_override_reason" text,
	"vocab_version_id" uuid,
	"face_to_face_encounter_id" uuid,
	"bereavement_plan_id" uuid,
	"document_id" uuid,
	"signed_at" timestamp with time zone,
	"cosigned_at" timestamp with time zone,
	"voided_at" timestamp with time zone,
	"voided_by" uuid,
	"voided_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "encounter_service_date_not_future" CHECK (service_date <= current_date),
	CONSTRAINT "encounter_late_reason_required" CHECK ((late_entry_tier = 'normal') OR (late_entry_reason IS NOT NULL AND char_length(late_entry_reason) >= 40)),
	CONSTRAINT "encounter_significant_late_consistency" CHECK ((late_entry_tier <> 'significant_late_entry')
          OR (significant_late_override_by IS NOT NULL AND significant_late_override_reason IS NOT NULL
              AND char_length(significant_late_override_reason) >= 40)),
	CONSTRAINT "encounter_administrative_override_consistency" CHECK ((late_entry_tier <> 'administrative_override')
          OR (administrative_override_by IS NOT NULL AND administrative_override_reason IS NOT NULL
              AND char_length(administrative_override_reason) >= 100)),
	CONSTRAINT "encounter_evv_missing_reason_len" CHECK ((evv_bracket_state IS DISTINCT FROM 'evv_missing_documented')
          OR (evv_missing_reason IS NOT NULL AND char_length(evv_missing_reason) >= 20)),
	CONSTRAINT "encounter_voided_consistency" CHECK ((status <> 'voided')
          OR (voided_at IS NOT NULL AND voided_by IS NOT NULL AND voided_reason IS NOT NULL
              AND char_length(voided_reason) >= 40)),
	CONSTRAINT "encounter_signed_has_time" CHECK ((status NOT IN ('signed','cosign_pending','cosigned')) OR (signed_at IS NOT NULL)),
	CONSTRAINT "encounter_vocab_pinned_when_finalized" CHECK ((status = 'draft') OR (vocab_version_id IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "encounter_addendum" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"encounter_id" uuid NOT NULL,
	"authored_by_membership_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"status" "encounter_status" DEFAULT 'draft' NOT NULL,
	"signed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "encounter_addendum_reason_len" CHECK (char_length(reason) >= 20),
	CONSTRAINT "encounter_addendum_status_allowed" CHECK (status IN ('draft','signed','voided')),
	CONSTRAINT "encounter_addendum_signed_has_time" CHECK ((status <> 'signed') OR (signed_at IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "encounter_signature" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"encounter_id" uuid NOT NULL,
	"addendum_id" uuid,
	"kind" "signature_kind" NOT NULL,
	"signed_by_membership_id" uuid NOT NULL,
	"signed_by_discipline" "encounter_discipline" NOT NULL,
	"signed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"method" "signature_method" NOT NULL,
	"session_id" uuid NOT NULL,
	"step_up_auth_at" timestamp with time zone NOT NULL,
	"attestation_text" text NOT NULL,
	"layer2_involved_at_signing" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "encounter_signature_step_up_fresh" CHECK (step_up_auth_at >= signed_at - interval '5 minutes'),
	CONSTRAINT "encounter_signature_addendum_when_addendum_kind" CHECK ((kind <> 'addendum') OR (addendum_id IS NOT NULL)),
	CONSTRAINT "encounter_signature_attestation_len" CHECK (char_length(attestation_text) >= 50)
);
--> statement-breakpoint
CREATE TABLE "encounter_care_plan_link" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"encounter_id" uuid NOT NULL,
	"problem_id" uuid,
	"goal_id" uuid,
	"intervention_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "encounter_care_plan_link_at_least_one" CHECK ((problem_id IS NOT NULL) OR (goal_id IS NOT NULL) OR (intervention_id IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "cosignature_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"encounter_id" uuid NOT NULL,
	"routed_to_membership_id" uuid NOT NULL,
	"status" "cosignature_status" DEFAULT 'pending' NOT NULL,
	"routed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"acknowledged_at" timestamp with time zone,
	"escalated_at" timestamp with time zone,
	"hard_cap_at" timestamp with time zone,
	"supervisor_released_at" timestamp with time zone,
	"supervisor_released_by" uuid,
	"supervisor_released_reason" text,
	"signed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "cosignature_request_encounter_id_unique" UNIQUE("encounter_id"),
	CONSTRAINT "cosignature_request_supervisor_release_consistency" CHECK ((status <> 'supervisor_released')
          OR (supervisor_released_at IS NOT NULL AND supervisor_released_by IS NOT NULL
              AND supervisor_released_reason IS NOT NULL AND char_length(supervisor_released_reason) >= 40))
);
--> statement-breakpoint
CREATE TABLE "vitals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"encounter_id" uuid NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"bp_systolic" integer,
	"bp_diastolic" integer,
	"heart_rate" integer,
	"respiratory_rate" integer,
	"temperature" text,
	"temperature_unit" "vital_unit",
	"spo2" integer,
	"pain_score" integer,
	"pain_scale" "pain_scale",
	"weight" text,
	"weight_unit" "vital_unit",
	"height" text,
	"height_unit" "vital_unit",
	"bmi" text,
	"blood_glucose" integer,
	"blood_glucose_unit" "vital_unit",
	"clinically_not_indicated_fields" text[],
	"clinically_not_indicated_reason" text,
	"loinc_references" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vitals_bp_range" CHECK ((bp_systolic IS NULL OR (bp_systolic BETWEEN 40 AND 260))
          AND (bp_diastolic IS NULL OR (bp_diastolic BETWEEN 20 AND 180))),
	CONSTRAINT "vitals_spo2_range" CHECK (spo2 IS NULL OR (spo2 BETWEEN 50 AND 100)),
	CONSTRAINT "vitals_pain_range" CHECK (pain_score IS NULL OR (pain_score BETWEEN 0 AND 10)),
	CONSTRAINT "vitals_cni_reason_required" CHECK ((clinically_not_indicated_fields IS NULL OR cardinality(clinically_not_indicated_fields) = 0)
          OR (clinically_not_indicated_reason IS NOT NULL AND char_length(clinically_not_indicated_reason) >= 20))
);
--> statement-breakpoint
CREATE TABLE "mileage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"encounter_id" uuid NOT NULL,
	"odometer_start" integer,
	"odometer_end" integer,
	"miles_driven" text NOT NULL,
	"miles_driven_source" text NOT NULL,
	"manual_override_reason" text,
	"route_proposed_miles" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mileage_encounter_id_unique" UNIQUE("encounter_id"),
	CONSTRAINT "mileage_override_reason_required" CHECK ((miles_driven_source <> 'manual_override')
          OR (manual_override_reason IS NOT NULL AND char_length(manual_override_reason) >= 20)),
	CONSTRAINT "mileage_odometer_order" CHECK ((odometer_start IS NULL OR odometer_end IS NULL) OR (odometer_end >= odometer_start))
);
--> statement-breakpoint
CREATE TABLE "hearthnote_selection" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"encounter_id" uuid,
	"addendum_id" uuid,
	"template_key" text NOT NULL,
	"template_version" text NOT NULL,
	"selections" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"free_text_cipher" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "hearthnote_selection_parent_xor" CHECK ((encounter_id IS NOT NULL) <> (addendum_id IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "hearthnote_assembled_output" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"encounter_id" uuid,
	"addendum_id" uuid,
	"kind" "assembled_output_kind" NOT NULL,
	"layer1_cipher" text NOT NULL,
	"layer2_cipher" text,
	"final_cipher" text NOT NULL,
	"layer2_eligibility" "layer2_eligibility_reason" NOT NULL,
	"layer2_involved_at_finalize" boolean DEFAULT false NOT NULL,
	"assembly_template_key" text NOT NULL,
	"vocab_version_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hearthnote_output_parent_xor" CHECK ((encounter_id IS NOT NULL) <> (addendum_id IS NOT NULL)),
	CONSTRAINT "hearthnote_output_layer2_consistency" CHECK ((layer2_involved_at_finalize = false AND layer2_cipher IS NULL)
          OR (layer2_involved_at_finalize = true AND layer2_cipher IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "hearthnote_llm_modification" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"assembled_output_id" uuid NOT NULL,
	"prompt_template_key" text NOT NULL,
	"prompt_template_version" text NOT NULL,
	"model_id" text NOT NULL,
	"tokens_input" integer NOT NULL,
	"tokens_output" integer NOT NULL,
	"latency_ms" integer NOT NULL,
	"diff_json" jsonb NOT NULL,
	"hard_blocked_count" integer DEFAULT 0 NOT NULL,
	"soft_warn_count" integer DEFAULT 0 NOT NULL,
	"per_passage_decisions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"called_at" timestamp with time zone DEFAULT now() NOT NULL,
	"called_by_membership_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "encounter" ADD CONSTRAINT "encounter_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter" ADD CONSTRAINT "encounter_provider_entity_id_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter" ADD CONSTRAINT "encounter_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter" ADD CONSTRAINT "encounter_authored_by_membership_id_membership_id_fk" FOREIGN KEY ("authored_by_membership_id") REFERENCES "public"."membership"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter" ADD CONSTRAINT "encounter_significant_late_override_by_membership_id_fk" FOREIGN KEY ("significant_late_override_by") REFERENCES "public"."membership"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter" ADD CONSTRAINT "encounter_administrative_override_by_membership_id_fk" FOREIGN KEY ("administrative_override_by") REFERENCES "public"."membership"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter" ADD CONSTRAINT "encounter_voided_by_membership_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."membership"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter_addendum" ADD CONSTRAINT "encounter_addendum_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter_addendum" ADD CONSTRAINT "encounter_addendum_provider_entity_id_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter_addendum" ADD CONSTRAINT "encounter_addendum_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter_addendum" ADD CONSTRAINT "encounter_addendum_encounter_id_encounter_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounter"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter_addendum" ADD CONSTRAINT "encounter_addendum_authored_by_membership_id_membership_id_fk" FOREIGN KEY ("authored_by_membership_id") REFERENCES "public"."membership"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter_signature" ADD CONSTRAINT "encounter_signature_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter_signature" ADD CONSTRAINT "encounter_signature_provider_entity_id_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter_signature" ADD CONSTRAINT "encounter_signature_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter_signature" ADD CONSTRAINT "encounter_signature_encounter_id_encounter_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounter"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter_signature" ADD CONSTRAINT "encounter_signature_addendum_id_encounter_addendum_id_fk" FOREIGN KEY ("addendum_id") REFERENCES "public"."encounter_addendum"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter_signature" ADD CONSTRAINT "encounter_signature_signed_by_membership_id_membership_id_fk" FOREIGN KEY ("signed_by_membership_id") REFERENCES "public"."membership"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter_care_plan_link" ADD CONSTRAINT "encounter_care_plan_link_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter_care_plan_link" ADD CONSTRAINT "encounter_care_plan_link_provider_entity_id_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter_care_plan_link" ADD CONSTRAINT "encounter_care_plan_link_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter_care_plan_link" ADD CONSTRAINT "encounter_care_plan_link_encounter_id_encounter_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounter"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cosignature_request" ADD CONSTRAINT "cosignature_request_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cosignature_request" ADD CONSTRAINT "cosignature_request_provider_entity_id_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cosignature_request" ADD CONSTRAINT "cosignature_request_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cosignature_request" ADD CONSTRAINT "cosignature_request_encounter_id_encounter_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounter"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cosignature_request" ADD CONSTRAINT "cosignature_request_routed_to_membership_id_membership_id_fk" FOREIGN KEY ("routed_to_membership_id") REFERENCES "public"."membership"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cosignature_request" ADD CONSTRAINT "cosignature_request_supervisor_released_by_membership_id_fk" FOREIGN KEY ("supervisor_released_by") REFERENCES "public"."membership"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vitals" ADD CONSTRAINT "vitals_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vitals" ADD CONSTRAINT "vitals_provider_entity_id_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vitals" ADD CONSTRAINT "vitals_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vitals" ADD CONSTRAINT "vitals_encounter_id_encounter_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounter"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mileage" ADD CONSTRAINT "mileage_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mileage" ADD CONSTRAINT "mileage_provider_entity_id_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mileage" ADD CONSTRAINT "mileage_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mileage" ADD CONSTRAINT "mileage_encounter_id_encounter_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounter"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hearthnote_selection" ADD CONSTRAINT "hearthnote_selection_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hearthnote_selection" ADD CONSTRAINT "hearthnote_selection_provider_entity_id_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hearthnote_selection" ADD CONSTRAINT "hearthnote_selection_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hearthnote_selection" ADD CONSTRAINT "hearthnote_selection_encounter_id_encounter_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounter"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hearthnote_selection" ADD CONSTRAINT "hearthnote_selection_addendum_id_encounter_addendum_id_fk" FOREIGN KEY ("addendum_id") REFERENCES "public"."encounter_addendum"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hearthnote_assembled_output" ADD CONSTRAINT "hearthnote_assembled_output_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hearthnote_assembled_output" ADD CONSTRAINT "hearthnote_assembled_output_provider_entity_id_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hearthnote_assembled_output" ADD CONSTRAINT "hearthnote_assembled_output_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hearthnote_assembled_output" ADD CONSTRAINT "hearthnote_assembled_output_encounter_id_encounter_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounter"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hearthnote_assembled_output" ADD CONSTRAINT "hearthnote_assembled_output_addendum_id_encounter_addendum_id_fk" FOREIGN KEY ("addendum_id") REFERENCES "public"."encounter_addendum"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hearthnote_llm_modification" ADD CONSTRAINT "hearthnote_llm_modification_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hearthnote_llm_modification" ADD CONSTRAINT "hearthnote_llm_modification_provider_entity_id_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hearthnote_llm_modification" ADD CONSTRAINT "hearthnote_llm_modification_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hearthnote_llm_modification" ADD CONSTRAINT "hearthnote_llm_modification_assembled_output_id_hearthnote_assembled_output_id_fk" FOREIGN KEY ("assembled_output_id") REFERENCES "public"."hearthnote_assembled_output"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hearthnote_llm_modification" ADD CONSTRAINT "hearthnote_llm_modification_called_by_membership_id_membership_id_fk" FOREIGN KEY ("called_by_membership_id") REFERENCES "public"."membership"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "encounter_patient_service_date_idx" ON "encounter" USING btree ("organization_id","patient_id","service_date");--> statement-breakpoint
CREATE INDEX "encounter_author_open_draft_idx" ON "encounter" USING btree ("organization_id","authored_by_membership_id","status") WHERE status = 'draft';--> statement-breakpoint
CREATE INDEX "encounter_signed_recent_idx" ON "encounter" USING btree ("organization_id","signed_at") WHERE status IN ('signed','cosign_pending','cosigned');--> statement-breakpoint
CREATE INDEX "encounter_cosign_pending_idx" ON "encounter" USING btree ("organization_id","signed_at") WHERE status = 'cosign_pending';--> statement-breakpoint
CREATE INDEX "encounter_addendum_encounter_idx" ON "encounter_addendum" USING btree ("encounter_id","created_at");--> statement-breakpoint
CREATE INDEX "encounter_signature_encounter_kind_idx" ON "encounter_signature" USING btree ("encounter_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "encounter_signature_unique_primary_idx" ON "encounter_signature" USING btree ("encounter_id") WHERE kind = 'primary';--> statement-breakpoint
CREATE UNIQUE INDEX "encounter_signature_unique_cosig_idx" ON "encounter_signature" USING btree ("encounter_id") WHERE kind = 'cosignature';--> statement-breakpoint
CREATE INDEX "encounter_care_plan_link_encounter_idx" ON "encounter_care_plan_link" USING btree ("encounter_id");--> statement-breakpoint
CREATE INDEX "cosignature_request_routed_to_idx" ON "cosignature_request" USING btree ("organization_id","routed_to_membership_id","status");--> statement-breakpoint
CREATE INDEX "cosignature_request_hard_cap_due_idx" ON "cosignature_request" USING btree ("organization_id","routed_at") WHERE status IN ('routed','escalated');--> statement-breakpoint
CREATE INDEX "vitals_encounter_idx" ON "vitals" USING btree ("encounter_id","captured_at");--> statement-breakpoint
CREATE INDEX "mileage_encounter_idx" ON "mileage" USING btree ("encounter_id");--> statement-breakpoint
CREATE INDEX "hearthnote_selection_encounter_unique_idx" ON "hearthnote_selection" USING btree ("encounter_id") WHERE encounter_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "hearthnote_selection_addendum_unique_idx" ON "hearthnote_selection" USING btree ("addendum_id") WHERE addendum_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "hearthnote_output_encounter_kind_idx" ON "hearthnote_assembled_output" USING btree ("encounter_id","kind");--> statement-breakpoint
CREATE INDEX "hearthnote_llm_modification_output_idx" ON "hearthnote_llm_modification" USING btree ("assembled_output_id");--> statement-breakpoint
CREATE INDEX "hearthnote_llm_modification_model_idx" ON "hearthnote_llm_modification" USING btree ("model_id","called_at");