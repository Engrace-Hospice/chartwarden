CREATE TYPE "public"."evv_aggregator_submission_status" AS ENUM('pending', 'queued', 'submitting', 'submitted', 'accepted', 'rejected', 'timeout', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."evv_device_platform" AS ENUM('ios', 'android');--> statement-breakpoint
CREATE TYPE "public"."evv_device_status" AS ENUM('pending_approval', 'approved', 'suspended', 'rejected', 'retired');--> statement-breakpoint
CREATE TYPE "public"."evv_event_gps_quality" AS ENUM('high', 'acceptable', 'degraded_attested', 'outside_geofence', 'no_geofence_baseline', 'suspected_spoof');--> statement-breakpoint
CREATE TYPE "public"."evv_event_kind" AS ENUM('check_in', 'check_out');--> statement-breakpoint
CREATE TYPE "public"."evv_geofence_policy_scope" AS ENUM('platform', 'tenant', 'patient_address');--> statement-breakpoint
CREATE TYPE "public"."evv_missing_resolution_kind" AS ENUM('missing_checkin', 'missing_checkout', 'outside_geofence_at_checkin', 'outside_geofence_at_checkout', 'device_integrity_failed_at_attempt');--> statement-breakpoint
CREATE TYPE "public"."evv_missing_resolution_status" AS ENUM('open', 'closed_clinician_attested', 'closed_supervisor_override', 'closed_visit_voided', 'closed_documented_at_encounter', 'closed_system_checkout_received');--> statement-breakpoint
CREATE TABLE "evv_event" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"visit_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"patient_address_id" uuid,
	"kind" "evv_event_kind" NOT NULL,
	"service_type_code" text NOT NULL,
	"posting_membership_id" uuid NOT NULL,
	"posting_discipline_at_recording" text NOT NULL,
	"evv_device_id" uuid NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"event_at" timestamp with time zone NOT NULL,
	"coords_cipher" text NOT NULL,
	"coords_dek_version" integer NOT NULL,
	"accuracy_m" real NOT NULL,
	"gps_quality" "evv_event_gps_quality" NOT NULL,
	"offline_capture" boolean DEFAULT false NOT NULL,
	"local_id" uuid,
	"synced_at" timestamp with time zone,
	"replaces_event_id" uuid,
	"superseded_at" timestamp with time zone,
	"superseded_by_event_id" uuid,
	"correction_reason" text,
	"device_attestation_id_at_record" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evv_event_id_event_at_pk" PRIMARY KEY("id","event_at")
);
--> statement-breakpoint
CREATE TABLE "evv_geofence_evaluation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"evv_event_id" uuid NOT NULL,
	"applied_policy_id" uuid NOT NULL,
	"applied_policy_scope" "evv_geofence_policy_scope" NOT NULL,
	"applied_radius_m" integer NOT NULL,
	"applied_max_accuracy_m" integer NOT NULL,
	"patient_address_coords_cipher" text,
	"device_coords_cipher" text NOT NULL,
	"computed_distance_m" real,
	"decision" text NOT NULL,
	"evaluated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evv_geofence_policy" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"scope" "evv_geofence_policy_scope" NOT NULL,
	"patient_address_id" uuid,
	"radius_m" integer NOT NULL,
	"max_accuracy_m" integer NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"override_reason" text,
	"set_by_membership_id" uuid NOT NULL,
	"version" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evv_device" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"platform" "evv_device_platform" NOT NULL,
	"model_description" text,
	"device_key_fingerprint" text NOT NULL,
	"m2_device_attestation_id" uuid NOT NULL,
	"status" "evv_device_status" DEFAULT 'pending_approval' NOT NULL,
	"approved_by_membership_id" uuid,
	"approved_at" timestamp with time zone,
	"rejected_by_membership_id" uuid,
	"rejected_at" timestamp with time zone,
	"denial_reason" text,
	"suspended_at" timestamp with time zone,
	"suspend_reason" text,
	"retired_at" timestamp with time zone,
	"last_event_at" timestamp with time zone,
	"version" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evv_missing_resolution" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"visit_id" uuid NOT NULL,
	"kind" "evv_missing_resolution_kind" NOT NULL,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"detected_by_source" text NOT NULL,
	"status" "evv_missing_resolution_status" DEFAULT 'open' NOT NULL,
	"resolved_by_membership_id" uuid,
	"resolved_at" timestamp with time zone,
	"resolution_reason" text,
	"step_up_auth_ref_id" uuid,
	"encounter_id_source" uuid,
	"version" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evv_aggregator_submission" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"visit_id" uuid NOT NULL,
	"check_in_event_id" uuid,
	"check_out_event_id" uuid,
	"event_pair_hash" text,
	"state_code" text NOT NULL,
	"aggregator_vendor" text NOT NULL,
	"status" "evv_aggregator_submission_status" DEFAULT 'pending' NOT NULL,
	"payload_cipher" text,
	"payload_dek_version" integer,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"next_retry_at" timestamp with time zone,
	"submitted_at" timestamp with time zone,
	"aggregator_transaction_id" text,
	"aggregator_response_cipher" text,
	"aggregator_response_at" timestamp with time zone,
	"aggregator_rejection_code" text,
	"aggregator_rejection_reason" text,
	"cancelled_by_membership_id" uuid,
	"cancelled_at" timestamp with time zone,
	"cancellation_reason" text,
	"resubmit_triggered_by_membership_id" uuid,
	"resubmit_triggered_at" timestamp with time zone,
	"version" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "evv_event" ADD CONSTRAINT "evv_event_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evv_event" ADD CONSTRAINT "evv_event_provider_entity_id_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evv_event" ADD CONSTRAINT "evv_event_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evv_event" ADD CONSTRAINT "evv_event_posting_membership_id_membership_id_fk" FOREIGN KEY ("posting_membership_id") REFERENCES "public"."membership"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evv_event" ADD CONSTRAINT "evv_event_evv_device_id_evv_device_id_fk" FOREIGN KEY ("evv_device_id") REFERENCES "public"."evv_device"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evv_geofence_evaluation" ADD CONSTRAINT "evv_geofence_evaluation_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evv_geofence_policy" ADD CONSTRAINT "evv_geofence_policy_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evv_geofence_policy" ADD CONSTRAINT "evv_geofence_policy_set_by_membership_id_membership_id_fk" FOREIGN KEY ("set_by_membership_id") REFERENCES "public"."membership"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evv_device" ADD CONSTRAINT "evv_device_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evv_device" ADD CONSTRAINT "evv_device_membership_id_membership_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."membership"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evv_missing_resolution" ADD CONSTRAINT "evv_missing_resolution_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evv_aggregator_submission" ADD CONSTRAINT "evv_aggregator_submission_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "evv_event_org_visit_idx" ON "evv_event" USING btree ("organization_id","visit_id","kind");--> statement-breakpoint
CREATE INDEX "evv_event_org_patient_idx" ON "evv_event" USING btree ("organization_id","patient_id","event_at");--> statement-breakpoint
CREATE INDEX "evv_event_org_membership_idx" ON "evv_event" USING btree ("organization_id","posting_membership_id","event_at");--> statement-breakpoint
CREATE INDEX "evv_event_org_device_idx" ON "evv_event" USING btree ("organization_id","evv_device_id","event_at");--> statement-breakpoint
CREATE INDEX "evv_event_org_gps_quality_idx" ON "evv_event" USING btree ("organization_id","gps_quality","event_at");--> statement-breakpoint
CREATE UNIQUE INDEX "evv_geofence_eval_event_uidx" ON "evv_geofence_evaluation" USING btree ("organization_id","evv_event_id");--> statement-breakpoint
CREATE INDEX "evv_geofence_eval_org_evaluated_idx" ON "evv_geofence_evaluation" USING btree ("organization_id","evaluated_at");--> statement-breakpoint
CREATE INDEX "evv_geofence_policy_org_scope_active_idx" ON "evv_geofence_policy" USING btree ("organization_id","scope","patient_address_id","effective_from") WHERE effective_to IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "evv_device_mem_key_active_uidx" ON "evv_device" USING btree ("membership_id","device_key_fingerprint") WHERE status IN ('pending_approval', 'approved', 'suspended');--> statement-breakpoint
CREATE INDEX "evv_device_org_mem_status_idx" ON "evv_device" USING btree ("organization_id","membership_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "evv_missing_resolution_open_uidx" ON "evv_missing_resolution" USING btree ("organization_id","visit_id","kind") WHERE status = 'open';--> statement-breakpoint
CREATE INDEX "evv_missing_resolution_org_visit_idx" ON "evv_missing_resolution" USING btree ("organization_id","visit_id");--> statement-breakpoint
CREATE INDEX "evv_missing_resolution_org_status_idx" ON "evv_missing_resolution" USING btree ("organization_id","status","detected_at");--> statement-breakpoint
CREATE UNIQUE INDEX "evv_aggregator_submission_state_visit_active_uidx" ON "evv_aggregator_submission" USING btree ("organization_id","state_code","visit_id") WHERE status != 'cancelled';--> statement-breakpoint
CREATE INDEX "evv_aggregator_submission_org_status_retry_idx" ON "evv_aggregator_submission" USING btree ("organization_id","status","next_retry_at") WHERE status IN ('queued', 'rejected', 'timeout');--> statement-breakpoint
CREATE INDEX "evv_aggregator_submission_org_vendor_state_idx" ON "evv_aggregator_submission" USING btree ("organization_id","aggregator_vendor","status");