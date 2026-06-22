CREATE TYPE "public"."order_discontinuation_reason" AS ENUM('clinical_judgement', 'patient_request', 'adverse_event', 'replaced_by_corrected_order', 'admission_discharged', 'level_of_care_change', 'standing_order_discontinued', 'corrected_replacement', 'expired_verbal');--> statement-breakpoint
CREATE TYPE "public"."order_kind" AS ENUM('lab', 'dme', 'level_of_care_change', 'recertification', 'comfort_kit', 'supply', 'ancillary_service', 'idg_requested');--> statement-breakpoint
CREATE TYPE "public"."order_priority" AS ENUM('routine', 'stat', 'asap');--> statement-breakpoint
CREATE TYPE "public"."order_results_status" AS ENUM('not_expected', 'awaiting_results', 'partial_results_received', 'results_received', 'results_overdue');--> statement-breakpoint
CREATE TYPE "public"."order_signature_kind" AS ENUM('signature', 'cosignature', 'verbal_attestation');--> statement-breakpoint
CREATE TYPE "public"."order_signature_target_kind" AS ENUM('order', 'medication_order');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('draft', 'pending_signature', 'verbal_pending', 'active', 'completed', 'discontinued', 'expired_unsigned');--> statement-breakpoint
CREATE TYPE "public"."order_transmission_status" AS ENUM('not_required', 'pending', 'pending_retry', 'transmitted', 'failed');--> statement-breakpoint
CREATE TYPE "public"."standing_order_cadence" AS ENUM('daily', 'weekly', 'biweekly', 'monthly', 'prn');--> statement-breakpoint
CREATE TYPE "public"."standing_order_spawned_by" AS ENUM('system', 'clinician_request');--> statement-breakpoint
CREATE TYPE "public"."standing_order_status" AS ENUM('active', 'paused', 'expired', 'discontinued');--> statement-breakpoint
CREATE TYPE "public"."verbal_order_status" AS ENUM('pending', 'signed_in_time', 'expired_unsigned');--> statement-breakpoint
CREATE TABLE "standing_order" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"admission_id" uuid NOT NULL,
	"kind" "order_kind" NOT NULL,
	"kind_version" text NOT NULL,
	"template_data" jsonb NOT NULL,
	"indication_text" text,
	"cadence" "standing_order_cadence" NOT NULL,
	"cadence_detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_until" timestamp with time zone,
	"max_spawns" integer,
	"spawn_count" integer DEFAULT 0 NOT NULL,
	"next_spawn_at" timestamp with time zone,
	"ordering_physician_mdm_id" uuid NOT NULL,
	"signed_by_membership_id" uuid,
	"signed_at" timestamp with time zone,
	"status" "standing_order_status" DEFAULT 'active' NOT NULL,
	"discontinued_at" timestamp with time zone,
	"discontinued_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_record" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"admission_id" uuid NOT NULL,
	"kind" "order_kind" NOT NULL,
	"kind_version" text NOT NULL,
	"data" jsonb NOT NULL,
	"priority" "order_priority" DEFAULT 'routine' NOT NULL,
	"indication_text" text,
	"status" "order_status" DEFAULT 'draft' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"drafter_membership_id" uuid NOT NULL,
	"drafter_discipline" text NOT NULL,
	"ordering_physician_mdm_id" uuid NOT NULL,
	"source_encounter_id" uuid,
	"triggering_assessment_id" uuid,
	"triggering_hope_assessment_id" uuid,
	"triggering_idg_decision_id" uuid,
	"replaces_order_id" uuid,
	"standing_order_id" uuid,
	"cosign_required" boolean DEFAULT false NOT NULL,
	"cosign_status" text,
	"transmission_status" "order_transmission_status" DEFAULT 'not_required' NOT NULL,
	"transmission_acked_at" timestamp with time zone,
	"transmission_ack_code" text,
	"transmission_failure_reason" text,
	"results_status" "order_results_status" DEFAULT 'not_expected' NOT NULL,
	"results_first_received_at" timestamp with time zone,
	"last_lab_observation_attached_id" uuid,
	"document_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"signed_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"discontinued_at" timestamp with time zone,
	CONSTRAINT "order_record_id_created_at_pk" PRIMARY KEY("id","created_at")
);
--> statement-breakpoint
CREATE TABLE "order_signature" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"target_kind" "order_signature_target_kind" NOT NULL,
	"target_id" uuid NOT NULL,
	"signature_kind" "order_signature_kind" NOT NULL,
	"signer_membership_id" uuid NOT NULL,
	"signer_discipline" text NOT NULL,
	"cosigner_role" text,
	"on_behalf_of_membership_id" uuid,
	"on_behalf_reason" text,
	"attestation_text" text,
	"signature_context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"signed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verbal_order" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"target_kind" "order_signature_target_kind" NOT NULL,
	"target_id" uuid NOT NULL,
	"recording_membership_id" uuid NOT NULL,
	"ordering_physician_mdm_id" uuid NOT NULL,
	"verbal_attestation" text NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"deadline_policy_version" text NOT NULL,
	"status" "verbal_order_status" DEFAULT 'pending' NOT NULL,
	"signed_at" timestamp with time zone,
	"expired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "standing_order_instance" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"standing_order_id" uuid NOT NULL,
	"order_record_id" uuid NOT NULL,
	"spawned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"spawned_by" "standing_order_spawned_by" NOT NULL,
	"spawned_by_membership_id" uuid,
	"spawn_context_note" text
);
--> statement-breakpoint
CREATE TABLE "order_discontinuation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"order_record_id" uuid NOT NULL,
	"actor_membership_id" uuid,
	"reason" "order_discontinuation_reason" NOT NULL,
	"notes" text,
	"effective_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_outbox_event_id" uuid
);
--> statement-breakpoint
CREATE TABLE "order_verbal_policy" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"window_hours" integer DEFAULT 48 NOT NULL,
	"business_hours_only" boolean DEFAULT false NOT NULL,
	"lpn_cosign_required_kinds" jsonb DEFAULT '["lab","dme","comfort_kit","supply","ancillary_service"]'::jsonb NOT NULL,
	"np_cosign_required_kinds" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"platform_floor_window_hours" integer DEFAULT 48 NOT NULL,
	"policy_version" text DEFAULT 'v1' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_membership_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "standing_order" ADD CONSTRAINT "standing_order_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standing_order" ADD CONSTRAINT "standing_order_provider_entity_id_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standing_order" ADD CONSTRAINT "standing_order_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standing_order" ADD CONSTRAINT "standing_order_signed_by_membership_id_membership_id_fk" FOREIGN KEY ("signed_by_membership_id") REFERENCES "public"."membership"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_record" ADD CONSTRAINT "order_record_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_record" ADD CONSTRAINT "order_record_provider_entity_id_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_record" ADD CONSTRAINT "order_record_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_record" ADD CONSTRAINT "order_record_drafter_membership_id_membership_id_fk" FOREIGN KEY ("drafter_membership_id") REFERENCES "public"."membership"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_record" ADD CONSTRAINT "order_record_standing_order_id_standing_order_id_fk" FOREIGN KEY ("standing_order_id") REFERENCES "public"."standing_order"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_signature" ADD CONSTRAINT "order_signature_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_signature" ADD CONSTRAINT "order_signature_provider_entity_id_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_signature" ADD CONSTRAINT "order_signature_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_signature" ADD CONSTRAINT "order_signature_signer_membership_id_membership_id_fk" FOREIGN KEY ("signer_membership_id") REFERENCES "public"."membership"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_signature" ADD CONSTRAINT "order_signature_on_behalf_of_membership_id_membership_id_fk" FOREIGN KEY ("on_behalf_of_membership_id") REFERENCES "public"."membership"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verbal_order" ADD CONSTRAINT "verbal_order_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verbal_order" ADD CONSTRAINT "verbal_order_provider_entity_id_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verbal_order" ADD CONSTRAINT "verbal_order_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verbal_order" ADD CONSTRAINT "verbal_order_recording_membership_id_membership_id_fk" FOREIGN KEY ("recording_membership_id") REFERENCES "public"."membership"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standing_order_instance" ADD CONSTRAINT "standing_order_instance_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standing_order_instance" ADD CONSTRAINT "standing_order_instance_provider_entity_id_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standing_order_instance" ADD CONSTRAINT "standing_order_instance_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standing_order_instance" ADD CONSTRAINT "standing_order_instance_standing_order_id_standing_order_id_fk" FOREIGN KEY ("standing_order_id") REFERENCES "public"."standing_order"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standing_order_instance" ADD CONSTRAINT "standing_order_instance_spawned_by_membership_id_membership_id_fk" FOREIGN KEY ("spawned_by_membership_id") REFERENCES "public"."membership"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_discontinuation" ADD CONSTRAINT "order_discontinuation_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_discontinuation" ADD CONSTRAINT "order_discontinuation_provider_entity_id_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_discontinuation" ADD CONSTRAINT "order_discontinuation_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_discontinuation" ADD CONSTRAINT "order_discontinuation_actor_membership_id_membership_id_fk" FOREIGN KEY ("actor_membership_id") REFERENCES "public"."membership"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_verbal_policy" ADD CONSTRAINT "order_verbal_policy_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_verbal_policy" ADD CONSTRAINT "order_verbal_policy_provider_entity_id_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_verbal_policy" ADD CONSTRAINT "order_verbal_policy_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_verbal_policy" ADD CONSTRAINT "order_verbal_policy_updated_by_membership_id_membership_id_fk" FOREIGN KEY ("updated_by_membership_id") REFERENCES "public"."membership"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "standing_order_active_next_spawn_idx" ON "standing_order" USING btree ("organization_id","next_spawn_at") WHERE status = 'active' AND next_spawn_at IS NOT NULL;--> statement-breakpoint
CREATE INDEX "standing_order_patient_status_idx" ON "standing_order" USING btree ("organization_id","patient_id","status");--> statement-breakpoint
CREATE INDEX "order_record_patient_status_idx" ON "order_record" USING btree ("organization_id","patient_id","status");--> statement-breakpoint
CREATE INDEX "order_record_admission_status_idx" ON "order_record" USING btree ("organization_id","admission_id","status");--> statement-breakpoint
CREATE INDEX "order_record_kind_status_idx" ON "order_record" USING btree ("organization_id","kind","status");--> statement-breakpoint
CREATE INDEX "order_record_physician_pending_idx" ON "order_record" USING btree ("organization_id","ordering_physician_mdm_id","status") WHERE status IN ('pending_signature','verbal_pending');--> statement-breakpoint
CREATE INDEX "order_record_replaces_idx" ON "order_record" USING btree ("replaces_order_id");--> statement-breakpoint
CREATE INDEX "order_record_standing_parent_idx" ON "order_record" USING btree ("standing_order_id");--> statement-breakpoint
CREATE INDEX "order_record_triggering_assessment_idx" ON "order_record" USING btree ("triggering_assessment_id");--> statement-breakpoint
CREATE INDEX "order_record_triggering_hope_idx" ON "order_record" USING btree ("triggering_hope_assessment_id");--> statement-breakpoint
CREATE INDEX "order_record_created_idx" ON "order_record" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_order_results_status_awaiting" ON "order_record" USING btree ("organization_id","results_status","signed_at") WHERE kind = 'lab' AND results_status IN ('awaiting_results', 'partial_results_received');--> statement-breakpoint
CREATE INDEX "idx_order_transmission_status" ON "order_record" USING btree ("organization_id","transmission_status","signed_at") WHERE kind = 'lab' AND transmission_status IN ('pending', 'pending_retry');--> statement-breakpoint
CREATE UNIQUE INDEX "order_signature_target_signature_uq" ON "order_signature" USING btree ("target_kind","target_id") WHERE signature_kind = 'signature';--> statement-breakpoint
CREATE INDEX "order_signature_target_idx" ON "order_signature" USING btree ("target_kind","target_id");--> statement-breakpoint
CREATE INDEX "order_signature_signer_idx" ON "order_signature" USING btree ("organization_id","signer_membership_id","signed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "verbal_order_target_uq" ON "verbal_order" USING btree ("target_kind","target_id");--> statement-breakpoint
CREATE INDEX "verbal_order_pending_deadline_idx" ON "verbal_order" USING btree ("organization_id","deadline_at") WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX "standing_order_instance_parent_idx" ON "standing_order_instance" USING btree ("organization_id","standing_order_id","spawned_at");--> statement-breakpoint
CREATE UNIQUE INDEX "standing_order_instance_order_uq" ON "standing_order_instance" USING btree ("order_record_id");--> statement-breakpoint
CREATE INDEX "order_discontinuation_order_idx" ON "order_discontinuation" USING btree ("order_record_id");--> statement-breakpoint
CREATE INDEX "order_discontinuation_actor_idx" ON "order_discontinuation" USING btree ("organization_id","actor_membership_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "order_verbal_policy_per_org_uq" ON "order_verbal_policy" USING btree ("organization_id");