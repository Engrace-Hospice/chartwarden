CREATE TYPE "public"."dea_schedule" AS ENUM('II', 'III', 'IV', 'V');--> statement-breakpoint
CREATE TYPE "public"."dosespot_send_state" AS ENUM('not_required', 'queued', 'in_flight', 'transmitted', 'acked', 'nacked', 'failed');--> statement-breakpoint
CREATE TYPE "public"."dosespot_webhook_event_type" AS ENUM('script_status_update', 'refill_request', 'medication_history_result', 'patient_mismatch', 'prescriber_status_changed');--> statement-breakpoint
CREATE TYPE "public"."epcs_certification_status" AS ENUM('not_certified', 'audit_in_progress', 'certified', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."epcs_second_factor_type" AS ENUM('totp', 'passkey', 'push_confirm');--> statement-breakpoint
CREATE TYPE "public"."epcs_signing_attempt_outcome" AS ENUM('pending', 'succeeded', 'failed_2fa', 'failed_timeout', 'failed_validation');--> statement-breakpoint
CREATE TYPE "public"."ial2_status" AS ENUM('not_started', 'in_progress', 'verified', 'expired', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."med_class" AS ENUM('standard', 'controlled_substance', 'compounded');--> statement-breakpoint
CREATE TYPE "public"."medication_history_source" AS ENUM('dosespot_medhx', 'manual_entry', 'reconciliation_carryforward');--> statement-breakpoint
CREATE TYPE "public"."medication_order_discontinuation_reason" AS ENUM('clinical_judgement', 'patient_request', 'adverse_event', 'replaced_by_corrected_order', 'admission_discharged', 'pharmacy_nack', 'corrected_replacement', 'expired_verbal', 'transmission_failed', 'no_refills_no_renewal');--> statement-breakpoint
CREATE TYPE "public"."medication_order_status" AS ENUM('draft', 'pending_signature', 'verbal_pending', 'epcs_identity_pending', 'signed', 'queued_for_transmission', 'transmitted', 'ack_received', 'nack_received', 'active', 'completed', 'discontinued', 'transmission_failed', 'expired_unsigned');--> statement-breakpoint
CREATE TYPE "public"."refill_request_status" AS ENUM('pending', 'approved', 'denied', 'expired');--> statement-breakpoint
CREATE TYPE "public"."refill_response_channel" AS ENUM('electronic_via_dosespot', 'phone', 'fax', 'in_person');--> statement-breakpoint
CREATE TABLE "medication_order" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"admission_id" uuid NOT NULL,
	"med_class" "med_class" NOT NULL,
	"is_controlled_substance" boolean DEFAULT false NOT NULL,
	"dea_schedule" "dea_schedule",
	"is_sud_treatment" boolean DEFAULT false NOT NULL,
	"rxnorm_rxcui" text,
	"ndc" text,
	"drug_name" text NOT NULL,
	"strength" text NOT NULL,
	"dose_form" text NOT NULL,
	"route" text NOT NULL,
	"data" jsonb NOT NULL,
	"prescriber_membership_id" uuid NOT NULL,
	"prescribing_physician_mdm_id" uuid NOT NULL,
	"dispensing_pharmacy_mdm_id" uuid,
	"refills_authorized" integer DEFAULT 0 NOT NULL,
	"refills_remaining" integer DEFAULT 0 NOT NULL,
	"status" "medication_order_status" DEFAULT 'draft' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"dosespot_send_state" "dosespot_send_state" DEFAULT 'not_required' NOT NULL,
	"dosespot_prescription_id" text,
	"replaces_medication_order_id" uuid,
	"derived_from_refill_id" uuid,
	"derived_from_history_id" uuid,
	"cosign_required" boolean DEFAULT false NOT NULL,
	"cosign_status" text,
	"document_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"signed_at" timestamp with time zone,
	"transmitted_at" timestamp with time zone,
	"ack_received_at" timestamp with time zone,
	"activated_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"discontinued_at" timestamp with time zone,
	CONSTRAINT "medication_order_id_created_at_pk" PRIMARY KEY("id","created_at"),
	CONSTRAINT "medication_order_controlled_schedule_consistency" CHECK ((is_controlled_substance = true) = (dea_schedule IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "medication_order_transmission" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"medication_order_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"rx_business_key" text NOT NULL,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"transmission_started_at" timestamp with time zone,
	"transmission_succeeded_at" timestamp with time zone,
	"transmission_failed_at" timestamp with time zone,
	"dosespot_prescription_id" text,
	"dosespot_response_digest" text,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"last_error_class" text,
	"last_error_detail" text,
	"correlation_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refill_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"source_medication_order_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"dosespot_event_id" text NOT NULL,
	"pharmacy_mdm_id" uuid,
	"pharmacy_ncpdp_at_receipt" text,
	"requested_quantity" text,
	"requested_days_supply" integer,
	"pharmacy_notes" text,
	"received_at" timestamp with time zone NOT NULL,
	"status" "refill_request_status" DEFAULT 'pending' NOT NULL,
	"approved_at" timestamp with time zone,
	"approved_by_membership_id" uuid,
	"denied_at" timestamp with time zone,
	"denied_by_membership_id" uuid,
	"denial_reason" text,
	"resulting_medication_order_id" uuid,
	"response_channel" "refill_response_channel",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dosespot_webhook_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"dosespot_event_id" text NOT NULL,
	"event_type" "dosespot_webhook_event_type" NOT NULL,
	"raw_body_cipher" text NOT NULL,
	"raw_body_dek" text NOT NULL,
	"body_digest" text NOT NULL,
	"signature_verified_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"correlation_id" text NOT NULL,
	"processed_at" timestamp with time zone,
	"processing_outcome" text,
	"processing_error_class" text
);
--> statement-breakpoint
CREATE TABLE "dosespot_prescriber" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"external_physician_mdm_id" uuid,
	"dosespot_prescriber_id" text,
	"npi" text NOT NULL,
	"dea" text,
	"dea_authorized_schedules" text[],
	"ial2_status" "ial2_status" DEFAULT 'not_started' NOT NULL,
	"ial2_verified_at" timestamp with time zone,
	"ial2_expires_at" timestamp with time zone,
	"epcs_enabled" boolean DEFAULT false NOT NULL,
	"enrolled_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revocation_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dosespot_prescriber_epcs_consistency" CHECK ((epcs_enabled = true) <= (ial2_status = 'verified' AND dea IS NOT NULL AND array_length(dea_authorized_schedules, 1) > 0))
);
--> statement-breakpoint
CREATE TABLE "epcs_signing_attempt" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"medication_order_id" uuid NOT NULL,
	"prescriber_membership_id" uuid NOT NULL,
	"nonce" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"second_factor_type" "epcs_second_factor_type",
	"signing_device" text,
	"ip_address_digest" text,
	"outcome" "epcs_signing_attempt_outcome" DEFAULT 'pending' NOT NULL,
	"outcome_detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "medication_order" ADD CONSTRAINT "medication_order_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medication_order" ADD CONSTRAINT "medication_order_provider_entity_id_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medication_order" ADD CONSTRAINT "medication_order_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medication_order" ADD CONSTRAINT "medication_order_prescriber_membership_id_membership_id_fk" FOREIGN KEY ("prescriber_membership_id") REFERENCES "public"."membership"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medication_order_transmission" ADD CONSTRAINT "medication_order_transmission_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refill_request" ADD CONSTRAINT "refill_request_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refill_request" ADD CONSTRAINT "refill_request_provider_entity_id_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refill_request" ADD CONSTRAINT "refill_request_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refill_request" ADD CONSTRAINT "refill_request_approved_by_membership_id_membership_id_fk" FOREIGN KEY ("approved_by_membership_id") REFERENCES "public"."membership"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refill_request" ADD CONSTRAINT "refill_request_denied_by_membership_id_membership_id_fk" FOREIGN KEY ("denied_by_membership_id") REFERENCES "public"."membership"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dosespot_webhook_event" ADD CONSTRAINT "dosespot_webhook_event_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dosespot_prescriber" ADD CONSTRAINT "dosespot_prescriber_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dosespot_prescriber" ADD CONSTRAINT "dosespot_prescriber_membership_id_membership_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."membership"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "epcs_signing_attempt" ADD CONSTRAINT "epcs_signing_attempt_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "epcs_signing_attempt" ADD CONSTRAINT "epcs_signing_attempt_prescriber_membership_id_membership_id_fk" FOREIGN KEY ("prescriber_membership_id") REFERENCES "public"."membership"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "medication_order_patient_status_idx" ON "medication_order" USING btree ("organization_id","patient_id","status");--> statement-breakpoint
CREATE INDEX "medication_order_admission_status_idx" ON "medication_order" USING btree ("organization_id","admission_id","status");--> statement-breakpoint
CREATE INDEX "medication_order_med_class_status_idx" ON "medication_order" USING btree ("organization_id","med_class","status");--> statement-breakpoint
CREATE INDEX "medication_order_prescriber_pending_idx" ON "medication_order" USING btree ("organization_id","prescriber_membership_id","status") WHERE status IN ('pending_signature','verbal_pending','epcs_identity_pending');--> statement-breakpoint
CREATE INDEX "medication_order_dosespot_prescription_idx" ON "medication_order" USING btree ("dosespot_prescription_id") WHERE dosespot_prescription_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "medication_order_created_idx" ON "medication_order" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "mot_idempotency_unique" ON "medication_order_transmission" USING btree ("organization_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "mot_in_flight_idx" ON "medication_order_transmission" USING btree ("organization_id","transmission_succeeded_at","transmission_failed_at") WHERE transmission_succeeded_at IS NULL AND transmission_failed_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "refill_request_dosespot_event_unique" ON "refill_request" USING btree ("organization_id","dosespot_event_id");--> statement-breakpoint
CREATE INDEX "refill_request_pending_sla_idx" ON "refill_request" USING btree ("organization_id","received_at") WHERE status = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "dswe_unique" ON "dosespot_webhook_event" USING btree ("organization_id","dosespot_event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "dosespot_prescriber_unique" ON "dosespot_prescriber" USING btree ("organization_id","membership_id");--> statement-breakpoint
CREATE INDEX "epcs_signing_attempt_order_idx" ON "epcs_signing_attempt" USING btree ("medication_order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "epcs_signing_attempt_nonce_unique" ON "epcs_signing_attempt" USING btree ("nonce");