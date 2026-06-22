CREATE TYPE "public"."administration_actor_kind" AS ENUM('clinician', 'caregiver_attested', 'system_iv_session_event');--> statement-breakpoint
CREATE TYPE "public"."administration_late_entry_tier" AS ENUM('normal', 'late', 'significant_late', 'administrative_override');--> statement-breakpoint
CREATE TYPE "public"."administration_mode" AS ENUM('single_dose', 'iv_continuous_start', 'iv_continuous_rate_change', 'iv_continuous_pause', 'iv_continuous_resume', 'iv_continuous_stop');--> statement-breakpoint
CREATE TYPE "public"."administration_status" AS ENUM('committed', 'pending_caregiver_review', 'superseded', 'voided');--> statement-breakpoint
CREATE TYPE "public"."administration_witness_kind" AS ENUM('co_present', 'telephonic');--> statement-breakpoint
CREATE TYPE "public"."administration_witnesses_scope" AS ENUM('administration_only', 'wastage_only', 'administration_and_wastage');--> statement-breakpoint
CREATE TYPE "public"."comfort_kit_disposal_status" AS ENUM('deployed', 'return_required', 'returned', 'disposed_unreturned');--> statement-breakpoint
CREATE TYPE "public"."comfort_kit_replenishment_urgency" AS ENUM('routine', 'urgent');--> statement-breakpoint
CREATE TYPE "public"."missed_dose_kind" AS ENUM('detected_by_sweep', 'intentionally_held', 'patient_refused');--> statement-breakpoint
CREATE TYPE "public"."offline_sync_status" AS ENUM('pending', 'synced', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."prn_requested_by_kind" AS ENUM('clinician_observed', 'patient_request', 'caregiver_request', 'scheduled_reassessment_protocol');--> statement-breakpoint
CREATE TYPE "public"."reconciliation_decision_kind" AS ENUM('carry_forward', 'discontinue', 'hold', 'new_order', 'document_only');--> statement-breakpoint
CREATE TYPE "public"."reconciliation_trigger_kind" AS ENUM('admission', 'transfer_in', 'discharge', 'recertification');--> statement-breakpoint
CREATE TYPE "public"."reconciliation_worksheet_status" AS ENUM('pending', 'in_progress', 'finalized', 'voided');--> statement-breakpoint
CREATE TYPE "public"."scheduled_dose_cancellation_reason" AS ENUM('order_discontinued', 'admission_discharged', 'corrected_replacement', 'tenant_policy');--> statement-breakpoint
CREATE TYPE "public"."scheduled_dose_status" AS ENUM('pending', 'administered', 'missed', 'cancelled', 'intentionally_held');--> statement-breakpoint
CREATE TABLE "administration_record" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"admission_id" uuid NOT NULL,
	"medication_order_id" uuid NOT NULL,
	"scheduled_dose_id" uuid,
	"prn_administration_id" uuid,
	"encounter_id" uuid,
	"comfort_kit_deployment_id" uuid,
	"iv_session_id" uuid,
	"mode" "administration_mode" NOT NULL,
	"status" "administration_status" DEFAULT 'committed' NOT NULL,
	"data" jsonb NOT NULL,
	"drug_name_snapshot" text NOT NULL,
	"rxnorm_rxcui_snapshot" text,
	"route_snapshot" text NOT NULL,
	"dose_amount_snapshot" numeric(12, 4),
	"dose_unit_snapshot" text,
	"is_controlled_substance" boolean DEFAULT false NOT NULL,
	"is_sud_treatment" boolean DEFAULT false NOT NULL,
	"is_comfort_kit_drawdown" boolean DEFAULT false NOT NULL,
	"administered_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_kind" "administration_actor_kind" NOT NULL,
	"administering_clinician_membership_id" uuid,
	"actor_caregiver_session_id" uuid,
	"caregiver_attestation_text" text,
	"requires_rn_review" boolean DEFAULT false NOT NULL,
	"acknowledged_by_membership_id" uuid,
	"acknowledged_at" timestamp with time zone,
	"disputed" boolean DEFAULT false NOT NULL,
	"dispute_reason" text,
	"witness_membership_id" uuid,
	"witness_attestation_token_digest" text,
	"witness_attested_at" timestamp with time zone,
	"late_entry_tier" "administration_late_entry_tier" DEFAULT 'normal' NOT NULL,
	"late_entry_reason" text,
	"significant_late_override_by" uuid,
	"administrative_override_by" uuid,
	"administrative_override_reason" text,
	"refused" boolean DEFAULT false NOT NULL,
	"refusal_reason" text,
	"notes" text,
	"offline_capture" boolean DEFAULT false NOT NULL,
	"device_id" uuid,
	"local_id" uuid,
	"corrects_administration_id" uuid,
	"correction_reason" text,
	"voided_at" timestamp with time zone,
	"voided_by" uuid,
	"void_reason" text,
	"document_id" uuid,
	"pump_programming_verified_by_membership_id" uuid,
	"dispense_cabinet_event_id" uuid,
	"vocab_version_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "administration_record_id_administered_at_pk" PRIMARY KEY("id","administered_at")
);
--> statement-breakpoint
CREATE TABLE "scheduled_dose" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"admission_id" uuid NOT NULL,
	"medication_order_id" uuid NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"grace_window_minutes" integer NOT NULL,
	"expected_dose_amount" numeric(12, 4) NOT NULL,
	"expected_dose_unit" text NOT NULL,
	"expected_route" text NOT NULL,
	"status" "scheduled_dose_status" DEFAULT 'pending' NOT NULL,
	"administered_at" timestamp with time zone,
	"missed_dose_id" uuid,
	"cancellation_reason" "scheduled_dose_cancellation_reason",
	"cancellation_source_event_id" uuid,
	"cancelled_at" timestamp with time zone,
	"materialization_sequence" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prn_administration" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"administration_record_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"admission_id" uuid NOT NULL,
	"medication_order_id" uuid NOT NULL,
	"triggering_prn_reason" text NOT NULL,
	"requested_by_kind" "prn_requested_by_kind" NOT NULL,
	"triggering_assessment_id" uuid,
	"reassessment_window_minutes" integer NOT NULL,
	"reassessment_due_at" timestamp with time zone NOT NULL,
	"recommended_reassessment_scale" text,
	"prn_interval_override" boolean DEFAULT false NOT NULL,
	"prn_interval_override_reason" text,
	"prn_interval_override_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "missed_dose" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"scheduled_dose_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"admission_id" uuid NOT NULL,
	"medication_order_id" uuid NOT NULL,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"missed_kind" "missed_dose_kind" NOT NULL,
	"missed_reason" text,
	"recorded_by_membership_id" uuid,
	"is_controlled_substance" boolean DEFAULT false NOT NULL,
	"acknowledged_at" timestamp with time zone,
	"acknowledged_by_membership_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "administration_witness" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"administration_record_id" uuid NOT NULL,
	"witness_membership_id" uuid NOT NULL,
	"witness_kind" "administration_witness_kind" DEFAULT 'co_present' NOT NULL,
	"witnesses_scope" "administration_witnesses_scope" NOT NULL,
	"attestation_text" text NOT NULL,
	"attestation_token_digest" text NOT NULL,
	"attested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"telephonic_witness_session_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "comfort_kit_deployment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"admission_id" uuid NOT NULL,
	"deployed_at" timestamp with time zone NOT NULL,
	"deployed_by_membership_id" uuid,
	"m21_supply_dispatch_id" uuid,
	"disposal_status" "comfort_kit_disposal_status" DEFAULT 'deployed' NOT NULL,
	"return_required_at" timestamp with time zone,
	"returned_at" timestamp with time zone,
	"disposal_reconciliation_status" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "comfort_kit_drawdown" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"comfort_kit_deployment_id" uuid NOT NULL,
	"medication_order_id" uuid NOT NULL,
	"expected_quantity" numeric(12, 4) NOT NULL,
	"expected_unit" text NOT NULL,
	"remaining_quantity" numeric(12, 4) NOT NULL,
	"final_remaining_quantity_at_return" numeric(12, 4),
	"replenishment_threshold" numeric(12, 4) NOT NULL,
	"lot_number" text,
	"expiration_date" date,
	"notes" text,
	"last_replenishment_emitted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "medication_reconciliation_worksheet" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"admission_id" uuid NOT NULL,
	"trigger_kind" "reconciliation_trigger_kind" NOT NULL,
	"trigger_outbox_event_id" uuid NOT NULL,
	"triggered_at" timestamp with time zone NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"finalized_at" timestamp with time zone,
	"finalized_by_membership_id" uuid,
	"status" "reconciliation_worksheet_status" DEFAULT 'pending' NOT NULL,
	"void_reason" text,
	"document_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "medication_reconciliation_decision" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"worksheet_id" uuid NOT NULL,
	"line_kind" text NOT NULL,
	"m12_medication_order_id" uuid,
	"m12_medication_history_record_id" uuid,
	"caregiver_reported_snapshot" jsonb,
	"decision_kind" "reconciliation_decision_kind" NOT NULL,
	"decision_made_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decision_made_by_membership_id" uuid NOT NULL,
	"decision_notes" text,
	"resulting_medication_order_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "barcode_scan_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"administration_record_id" uuid,
	"scanned_ndc" text,
	"scanned_rxnorm_rxcui" text,
	"scanned_lot_number" text,
	"scanned_expiration_date" date,
	"patient_wristband_scanned_at" timestamp with time zone,
	"patient_wristband_payload_digest" text,
	"match_result" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "administration_offline_queue" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"local_id" uuid NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sync_status" "offline_sync_status" DEFAULT 'pending' NOT NULL,
	"synced_administration_record_id" uuid,
	"rejection_reason_code" text,
	"rejection_reason_detail" text,
	"payload_envelope_digest" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "administration_policy" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"default_grace_window_minutes" integer DEFAULT 60 NOT NULL,
	"controlled_grace_window_minutes" integer DEFAULT 30 NOT NULL,
	"iv_continuous_grace_window_minutes" integer DEFAULT 15 NOT NULL,
	"default_prn_reassessment_window_minutes" integer DEFAULT 60 NOT NULL,
	"sedative_prn_reassessment_window_minutes" integer DEFAULT 120 NOT NULL,
	"breakthrough_pain_prn_reassessment_window_minutes" integer DEFAULT 30 NOT NULL,
	"materialization_window_days" integer DEFAULT 7 NOT NULL,
	"state_overrides" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"emar_per_administration_pdf_enabled" boolean DEFAULT false NOT NULL,
	"caregiver_attested_capture_enabled" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "administration_policy_organization_id_unique" UNIQUE("organization_id")
);
--> statement-breakpoint
ALTER TABLE "administration_record" ADD CONSTRAINT "administration_record_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "administration_record" ADD CONSTRAINT "administration_record_provider_entity_id_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "administration_record" ADD CONSTRAINT "administration_record_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_dose" ADD CONSTRAINT "scheduled_dose_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_dose" ADD CONSTRAINT "scheduled_dose_provider_entity_id_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_dose" ADD CONSTRAINT "scheduled_dose_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prn_administration" ADD CONSTRAINT "prn_administration_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prn_administration" ADD CONSTRAINT "prn_administration_provider_entity_id_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prn_administration" ADD CONSTRAINT "prn_administration_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "missed_dose" ADD CONSTRAINT "missed_dose_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "missed_dose" ADD CONSTRAINT "missed_dose_provider_entity_id_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "missed_dose" ADD CONSTRAINT "missed_dose_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "administration_witness" ADD CONSTRAINT "administration_witness_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comfort_kit_deployment" ADD CONSTRAINT "comfort_kit_deployment_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comfort_kit_deployment" ADD CONSTRAINT "comfort_kit_deployment_provider_entity_id_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comfort_kit_deployment" ADD CONSTRAINT "comfort_kit_deployment_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comfort_kit_drawdown" ADD CONSTRAINT "comfort_kit_drawdown_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medication_reconciliation_worksheet" ADD CONSTRAINT "medication_reconciliation_worksheet_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medication_reconciliation_worksheet" ADD CONSTRAINT "medication_reconciliation_worksheet_provider_entity_id_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medication_reconciliation_worksheet" ADD CONSTRAINT "medication_reconciliation_worksheet_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medication_reconciliation_decision" ADD CONSTRAINT "medication_reconciliation_decision_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "barcode_scan_event" ADD CONSTRAINT "barcode_scan_event_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "administration_offline_queue" ADD CONSTRAINT "administration_offline_queue_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "administration_policy" ADD CONSTRAINT "administration_policy_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "admin_rec_patient_time_idx" ON "administration_record" USING btree ("organization_id","patient_id","administered_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "admin_rec_order_time_idx" ON "administration_record" USING btree ("organization_id","medication_order_id","administered_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "admin_rec_scheduled_dose_idx" ON "administration_record" USING btree ("scheduled_dose_id") WHERE scheduled_dose_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "admin_rec_encounter_idx" ON "administration_record" USING btree ("encounter_id") WHERE encounter_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "admin_rec_iv_session_idx" ON "administration_record" USING btree ("organization_id","iv_session_id","administered_at") WHERE iv_session_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "admin_rec_pending_caregiver_review_idx" ON "administration_record" USING btree ("organization_id","requires_rn_review","recorded_at" DESC NULLS LAST) WHERE requires_rn_review = true;--> statement-breakpoint
CREATE INDEX "admin_rec_offline_capture_idx" ON "administration_record" USING btree ("organization_id","device_id","local_id") WHERE offline_capture = true;--> statement-breakpoint
CREATE INDEX "admin_rec_drug_route_idx" ON "administration_record" USING btree ("rxnorm_rxcui_snapshot","route_snapshot");--> statement-breakpoint
CREATE INDEX "sched_dose_patient_time_idx" ON "scheduled_dose" USING btree ("organization_id","patient_id","due_at");--> statement-breakpoint
CREATE INDEX "sched_dose_order_time_idx" ON "scheduled_dose" USING btree ("organization_id","medication_order_id","due_at");--> statement-breakpoint
CREATE INDEX "sched_dose_pending_sweep_idx" ON "scheduled_dose" USING btree ("due_at") WHERE status = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "sched_dose_order_due_uk" ON "scheduled_dose" USING btree ("organization_id","medication_order_id","due_at");--> statement-breakpoint
CREATE UNIQUE INDEX "prn_admin_record_uk" ON "prn_administration" USING btree ("administration_record_id");--> statement-breakpoint
CREATE INDEX "prn_admin_patient_time_idx" ON "prn_administration" USING btree ("organization_id","patient_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "prn_admin_order_time_idx" ON "prn_administration" USING btree ("organization_id","medication_order_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "prn_admin_reassessment_due_idx" ON "prn_administration" USING btree ("reassessment_due_at");--> statement-breakpoint
CREATE UNIQUE INDEX "missed_dose_scheduled_dose_uk" ON "missed_dose" USING btree ("scheduled_dose_id");--> statement-breakpoint
CREATE INDEX "missed_dose_patient_time_idx" ON "missed_dose" USING btree ("organization_id","patient_id","detected_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "missed_dose_order_time_idx" ON "missed_dose" USING btree ("organization_id","medication_order_id","detected_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "missed_dose_unacknowledged_idx" ON "missed_dose" USING btree ("organization_id","detected_at" DESC NULLS LAST) WHERE acknowledged_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "admin_witness_admin_uk" ON "administration_witness" USING btree ("administration_record_id");--> statement-breakpoint
CREATE INDEX "admin_witness_witness_idx" ON "administration_witness" USING btree ("organization_id","witness_membership_id","attested_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "kit_deploy_patient_idx" ON "comfort_kit_deployment" USING btree ("organization_id","patient_id","deployed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "kit_deploy_return_required_idx" ON "comfort_kit_deployment" USING btree ("organization_id","return_required_at") WHERE disposal_status = 'return_required';--> statement-breakpoint
CREATE INDEX "kit_drawdown_deployment_idx" ON "comfort_kit_drawdown" USING btree ("comfort_kit_deployment_id");--> statement-breakpoint
CREATE INDEX "kit_drawdown_order_idx" ON "comfort_kit_drawdown" USING btree ("organization_id","medication_order_id");--> statement-breakpoint
CREATE INDEX "kit_drawdown_below_threshold_idx" ON "comfort_kit_drawdown" USING btree ("organization_id") WHERE remaining_quantity <= replenishment_threshold;--> statement-breakpoint
CREATE UNIQUE INDEX "kit_drawdown_deployment_order_uk" ON "comfort_kit_drawdown" USING btree ("comfort_kit_deployment_id","medication_order_id");--> statement-breakpoint
CREATE INDEX "recon_ws_patient_idx" ON "medication_reconciliation_worksheet" USING btree ("organization_id","patient_id","triggered_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "recon_ws_pending_due_idx" ON "medication_reconciliation_worksheet" USING btree ("due_at") WHERE status IN ('pending','in_progress');--> statement-breakpoint
CREATE UNIQUE INDEX "recon_ws_admission_trigger_uk" ON "medication_reconciliation_worksheet" USING btree ("organization_id","admission_id","trigger_kind","trigger_outbox_event_id");--> statement-breakpoint
CREATE INDEX "recon_dec_worksheet_idx" ON "medication_reconciliation_decision" USING btree ("worksheet_id");--> statement-breakpoint
CREATE INDEX "recon_dec_order_idx" ON "medication_reconciliation_decision" USING btree ("organization_id","m12_medication_order_id") WHERE m12_medication_order_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "barcode_admin_idx" ON "barcode_scan_event" USING btree ("administration_record_id");--> statement-breakpoint
CREATE INDEX "barcode_wristband_idx" ON "barcode_scan_event" USING btree ("organization_id","patient_wristband_payload_digest");--> statement-breakpoint
CREATE UNIQUE INDEX "offline_q_device_local_uk" ON "administration_offline_queue" USING btree ("organization_id","device_id","local_id");--> statement-breakpoint
CREATE INDEX "offline_q_pending_idx" ON "administration_offline_queue" USING btree ("organization_id","received_at") WHERE sync_status = 'pending';