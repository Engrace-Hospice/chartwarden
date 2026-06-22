CREATE TYPE "public"."idg_action_item_linked_kind" AS ENUM('care_plan_version', 'order', 'encounter', 'medication_order');--> statement-breakpoint
CREATE TYPE "public"."idg_action_item_status" AS ENUM('open', 'in_progress', 'completed', 'cancelled', 'auto_closed');--> statement-breakpoint
CREATE TYPE "public"."idg_agenda_item_kind" AS ENUM('patient_review', 'carry_forward', 'administrative_note', 'family_meeting_setup', 'other');--> statement-breakpoint
CREATE TYPE "public"."idg_attendance_status" AS ENUM('present', 'tardy', 'partial', 'absent', 'excused');--> statement-breakpoint
CREATE TYPE "public"."idg_decision_kind" AS ENUM('care_plan_update', 'order_request', 'medication_recommendation', 'level_of_care_consideration', 'recertification_consideration', 'family_meeting_needed', 'bereavement_risk_flag', 'referral', 'team_note');--> statement-breakpoint
CREATE TYPE "public"."idg_decision_status" AS ENUM('open', 'emitted', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."idg_meeting_status" AS ENUM('scheduled', 'packets_building', 'packets_ready', 'live', 'adjourned', 'cancelled', 'rescheduled');--> statement-breakpoint
CREATE TYPE "public"."idg_minutes_status" AS ENUM('in_progress', 'final');--> statement-breakpoint
CREATE TABLE "idg_recurring_policy" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"cadence_days" integer DEFAULT 14 NOT NULL,
	"day_of_week_anchor" text NOT NULL,
	"start_time_local" time DEFAULT '09:00' NOT NULL,
	"duration_minutes" integer DEFAULT 120 NOT NULL,
	"post_discharge_wrap_up_days" integer DEFAULT 7 NOT NULL,
	"default_coordinator_membership_id" uuid NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idg_meeting" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"recurring_policy_id" uuid,
	"scheduled_start" timestamp with time zone NOT NULL,
	"scheduled_end" timestamp with time zone NOT NULL,
	"actual_start" timestamp with time zone,
	"actual_end" timestamp with time zone,
	"status" "idg_meeting_status" DEFAULT 'scheduled' NOT NULL,
	"coordinator_membership_id" uuid NOT NULL,
	"rescheduled_from_meeting_id" uuid,
	"cancellation_reason" text,
	"layer2_polish_opt_out" boolean DEFAULT false NOT NULL,
	"tenant_quorum_snapshot" jsonb NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idg_attendance" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"idg_meeting_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"discipline" text NOT NULL,
	"status" "idg_attendance_status" DEFAULT 'absent' NOT NULL,
	"check_in_at" timestamp with time zone,
	"check_out_at" timestamp with time zone,
	"absence_note" text,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idg_agenda_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid,
	"location_id" uuid,
	"idg_meeting_id" uuid NOT NULL,
	"patient_id" uuid,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"title" text NOT NULL,
	"body_text" text,
	"kind" "idg_agenda_item_kind" NOT NULL,
	"carried_from_action_item_id" uuid,
	"added_by_membership_id" uuid NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idg_decision" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid,
	"location_id" uuid,
	"idg_meeting_id" uuid NOT NULL,
	"patient_id" uuid,
	"agenda_item_id" uuid,
	"decision_kind" "idg_decision_kind" NOT NULL,
	"payload" jsonb NOT NULL,
	"was_quorate" boolean NOT NULL,
	"quorum_snapshot" jsonb NOT NULL,
	"recorded_by_membership_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" "idg_decision_status" DEFAULT 'open' NOT NULL,
	"superseded_by_decision_id" uuid,
	"superseded_at" timestamp with time zone,
	"emitted_at" timestamp with time zone,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idg_action_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid,
	"location_id" uuid,
	"idg_meeting_id" uuid NOT NULL,
	"idg_decision_id" uuid,
	"patient_id" uuid,
	"assigned_to_membership_id" uuid NOT NULL,
	"assigned_to_discipline" text,
	"title" text NOT NULL,
	"body_text" text,
	"due_date" timestamp with time zone,
	"status" "idg_action_item_status" DEFAULT 'open' NOT NULL,
	"linked_artifact_kind" "idg_action_item_linked_kind",
	"linked_artifact_id" uuid,
	"closed_at" timestamp with time zone,
	"close_reason" text,
	"meeting_carry_forward_count" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idg_minutes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"idg_meeting_id" uuid NOT NULL,
	"status" "idg_minutes_status" DEFAULT 'in_progress' NOT NULL,
	"attendance_snapshot" jsonb,
	"decision_list_snapshot" jsonb,
	"action_item_list_snapshot" jsonb,
	"closing_note" text,
	"finalized_by_membership_id" uuid,
	"finalized_at" timestamp with time zone,
	"minutes_document_id" uuid,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idg_minutes_amendment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"idg_minutes_id" uuid NOT NULL,
	"amendment_reason" text NOT NULL,
	"amendment_diff" jsonb NOT NULL,
	"requested_by_membership_id" uuid NOT NULL,
	"approved_by_membership_id" uuid,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idg_patient_packet" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"idg_meeting_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"admission_id" uuid NOT NULL,
	"built_at" timestamp with time zone DEFAULT now() NOT NULL,
	"frozen_at" timestamp with time zone,
	"last_idg_reviewed_at" timestamp with time zone,
	"since_cursor_iso" text NOT NULL,
	"built_snapshot" jsonb NOT NULL,
	"discipline_views" jsonb NOT NULL,
	"cover_summary_layer1" text NOT NULL,
	"cover_summary_layer2" text,
	"packet_document_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idg_patient_packet_id_built_at_pk" PRIMARY KEY("id","built_at")
);
--> statement-breakpoint
ALTER TABLE "idg_recurring_policy" ADD CONSTRAINT "idg_recurring_policy_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idg_recurring_policy" ADD CONSTRAINT "idg_recurring_policy_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idg_meeting" ADD CONSTRAINT "idg_meeting_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idg_meeting" ADD CONSTRAINT "idg_meeting_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idg_meeting" ADD CONSTRAINT "idg_meeting_recurring_policy_id_idg_recurring_policy_id_fk" FOREIGN KEY ("recurring_policy_id") REFERENCES "public"."idg_recurring_policy"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idg_attendance" ADD CONSTRAINT "idg_attendance_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idg_attendance" ADD CONSTRAINT "idg_attendance_idg_meeting_id_idg_meeting_id_fk" FOREIGN KEY ("idg_meeting_id") REFERENCES "public"."idg_meeting"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idg_agenda_item" ADD CONSTRAINT "idg_agenda_item_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idg_agenda_item" ADD CONSTRAINT "idg_agenda_item_provider_entity_id_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idg_agenda_item" ADD CONSTRAINT "idg_agenda_item_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idg_agenda_item" ADD CONSTRAINT "idg_agenda_item_idg_meeting_id_idg_meeting_id_fk" FOREIGN KEY ("idg_meeting_id") REFERENCES "public"."idg_meeting"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idg_decision" ADD CONSTRAINT "idg_decision_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idg_decision" ADD CONSTRAINT "idg_decision_provider_entity_id_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idg_decision" ADD CONSTRAINT "idg_decision_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idg_decision" ADD CONSTRAINT "idg_decision_idg_meeting_id_idg_meeting_id_fk" FOREIGN KEY ("idg_meeting_id") REFERENCES "public"."idg_meeting"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idg_decision" ADD CONSTRAINT "idg_decision_agenda_item_id_idg_agenda_item_id_fk" FOREIGN KEY ("agenda_item_id") REFERENCES "public"."idg_agenda_item"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idg_action_item" ADD CONSTRAINT "idg_action_item_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idg_action_item" ADD CONSTRAINT "idg_action_item_provider_entity_id_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idg_action_item" ADD CONSTRAINT "idg_action_item_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idg_action_item" ADD CONSTRAINT "idg_action_item_idg_meeting_id_idg_meeting_id_fk" FOREIGN KEY ("idg_meeting_id") REFERENCES "public"."idg_meeting"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idg_action_item" ADD CONSTRAINT "idg_action_item_idg_decision_id_idg_decision_id_fk" FOREIGN KEY ("idg_decision_id") REFERENCES "public"."idg_decision"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idg_minutes" ADD CONSTRAINT "idg_minutes_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idg_minutes" ADD CONSTRAINT "idg_minutes_idg_meeting_id_idg_meeting_id_fk" FOREIGN KEY ("idg_meeting_id") REFERENCES "public"."idg_meeting"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idg_minutes_amendment" ADD CONSTRAINT "idg_minutes_amendment_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idg_minutes_amendment" ADD CONSTRAINT "idg_minutes_amendment_idg_minutes_id_idg_minutes_id_fk" FOREIGN KEY ("idg_minutes_id") REFERENCES "public"."idg_minutes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idg_patient_packet" ADD CONSTRAINT "idg_patient_packet_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idg_patient_packet" ADD CONSTRAINT "idg_patient_packet_provider_entity_id_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idg_patient_packet" ADD CONSTRAINT "idg_patient_packet_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idg_meeting_location_scheduled_idx" ON "idg_meeting" USING btree ("organization_id","location_id","scheduled_start") WHERE status IN ('scheduled', 'packets_building', 'packets_ready');--> statement-breakpoint
CREATE INDEX "idg_attendance_meeting_discipline_idx" ON "idg_attendance" USING btree ("organization_id","idg_meeting_id","discipline","status");--> statement-breakpoint
CREATE INDEX "idg_agenda_item_meeting_idx" ON "idg_agenda_item" USING btree ("organization_id","idg_meeting_id","sort_order");--> statement-breakpoint
CREATE INDEX "idg_decision_meeting_status_idx" ON "idg_decision" USING btree ("organization_id","idg_meeting_id","status");--> statement-breakpoint
CREATE INDEX "idg_action_item_assignee_open_idx" ON "idg_action_item" USING btree ("organization_id","assigned_to_membership_id","due_date") WHERE status IN ('open', 'in_progress');--> statement-breakpoint
CREATE UNIQUE INDEX "idg_minutes_meeting_uniq" ON "idg_minutes" USING btree ("organization_id","idg_meeting_id");--> statement-breakpoint
CREATE INDEX "idg_patient_packet_meeting_patient_idx" ON "idg_patient_packet" USING btree ("organization_id","idg_meeting_id","patient_id");--> statement-breakpoint
CREATE INDEX "idg_patient_packet_admission_reviewed_idx" ON "idg_patient_packet" USING btree ("organization_id","admission_id","last_idg_reviewed_at" DESC NULLS LAST);