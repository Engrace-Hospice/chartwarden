CREATE TYPE "public"."recurring_visit_status" AS ENUM('active', 'discontinued');--> statement-breakpoint
CREATE TYPE "public"."time_off_kind" AS ENUM('pto', 'sick', 'bereavement', 'training', 'other');--> statement-breakpoint
CREATE TYPE "public"."time_off_state" AS ENUM('requested', 'approved', 'denied', 'cancelled', 'consumed');--> statement-breakpoint
CREATE TYPE "public"."visit_proposal_source" AS ENUM('frequency_driven_m7', 'supervisory_cadence_m15', 'order_required_m11', 'idg_decision_m14');--> statement-breakpoint
CREATE TYPE "public"."visit_proposal_status" AS ENUM('pending', 'published', 'dismissed', 'stale');--> statement-breakpoint
CREATE TYPE "public"."visit_purpose" AS ENUM('routine_visit', 'prn', 'aide_poc', 'msw_assessment', 'msw_followup', 'chaplain_visit', 'chaplain_assessment', 'volunteer_visit', 'f2f', 'recert', 'loc_change', 'pronouncement', 'admission_visit', 'discharge_visit');--> statement-breakpoint
CREATE TYPE "public"."visit_setting" AS ENUM('patient_home', 'facility', 'inpatient_unit', 'telephonic');--> statement-breakpoint
CREATE TYPE "public"."visit_status" AS ENUM('proposed', 'published', 'en_route', 'in_visit', 'completed', 'no_show', 'cancelled', 'rescheduled');--> statement-breakpoint
CREATE TABLE "visit" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"admission_id" uuid NOT NULL,
	"patient_address_id" uuid,
	"external_facility_id" uuid,
	"assigned_membership_id" uuid NOT NULL,
	"assigned_discipline_at_assignment" text NOT NULL,
	"visit_purpose" "visit_purpose" NOT NULL,
	"visit_setting" "visit_setting" NOT NULL,
	"scheduled_started_at" timestamp with time zone NOT NULL,
	"scheduled_ended_at" timestamp with time zone NOT NULL,
	"service_date" date NOT NULL,
	"actual_started_at" timestamp with time zone,
	"actual_ended_at" timestamp with time zone,
	"status" "visit_status" DEFAULT 'proposed' NOT NULL,
	"evv_bracket_state" "evv_bracket_state",
	"evv_check_in_event_id" uuid,
	"evv_check_out_event_id" uuid,
	"evv_missing_reason" text,
	"parent_recurring_visit_id" uuid,
	"parent_proposal_id" uuid,
	"encounter_id" uuid,
	"telehealth_room_id" uuid,
	"scheduler_internal_notes" text,
	"cancelled_by_membership_id" uuid,
	"cancelled_at" timestamp with time zone,
	"cancellation_reason" text,
	"cancellation_reason_code" text,
	"rescheduled_into_visit_id" uuid,
	"rescheduled_from_visit_id" uuid,
	"reschedule_reason" text,
	"no_show_detected_at" timestamp with time zone,
	"no_show_reason" text,
	"proposed_route_sequence_index" integer,
	"proposed_inbound_miles" integer,
	"proposed_inbound_drive_minutes" integer,
	"caregiver_reminder_opt_in" boolean DEFAULT false NOT NULL,
	"caregiver_reminder_sent_at" timestamp with time zone,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "visit_id_service_date_pk" PRIMARY KEY("id","service_date")
);
--> statement-breakpoint
CREATE TABLE "visit_state_history" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid,
	"location_id" uuid,
	"visit_id" uuid NOT NULL,
	"from_state" "visit_status",
	"to_state" "visit_status" NOT NULL,
	"actor_membership_id" uuid,
	"system_source" text,
	"reason" text,
	"outbox_event_id" uuid,
	"transitioned_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "visit_state_history_id_transitioned_at_pk" PRIMARY KEY("id","transitioned_at")
);
--> statement-breakpoint
CREATE TABLE "recurring_visit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"admission_id" uuid NOT NULL,
	"assigned_membership_id" uuid NOT NULL,
	"visit_purpose" "visit_purpose" NOT NULL,
	"visit_setting" "visit_setting" NOT NULL,
	"patient_address_id" uuid,
	"external_facility_id" uuid,
	"rrule" text NOT NULL,
	"byday" text[],
	"time_of_day_start" text NOT NULL,
	"time_of_day_end" text NOT NULL,
	"time_zone" text NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date,
	"count" integer,
	"status" "recurring_visit_status" DEFAULT 'active' NOT NULL,
	"discontinued_at" timestamp with time zone,
	"discontinued_by" uuid,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "visit_proposal" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"admission_id" uuid NOT NULL,
	"source" "visit_proposal_source" NOT NULL,
	"source_payload" jsonb NOT NULL,
	"source_idempotency_key" text NOT NULL,
	"proposed_for_date" date NOT NULL,
	"proposed_visit_purpose" "visit_purpose" NOT NULL,
	"proposed_discipline" text NOT NULL,
	"proposed_duration_minutes" integer NOT NULL,
	"suggested_membership_id" uuid,
	"status" "visit_proposal_status" DEFAULT 'pending' NOT NULL,
	"published_as_visit_id" uuid,
	"dismissed_by" uuid,
	"dismissal_reason" text,
	"stale_at" timestamp with time zone,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clinician_availability" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid,
	"location_id" uuid,
	"membership_id" uuid NOT NULL,
	"day_of_week" integer NOT NULL,
	"start_time" text NOT NULL,
	"end_time" text NOT NULL,
	"default_start_location_id" uuid,
	"default_end_location_id" uuid,
	"effective_start_date" date,
	"effective_end_date" date,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "time_off" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid,
	"location_id" uuid,
	"membership_id" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"kind" time_off_kind NOT NULL,
	"approval_state" time_off_state DEFAULT 'requested' NOT NULL,
	"request_note" text,
	"approved_by_membership_id" uuid,
	"approved_at" timestamp with time zone,
	"denied_by_membership_id" uuid,
	"denied_at" timestamp with time zone,
	"denial_reason" text,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" uuid,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "route_segment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid,
	"location_id" uuid,
	"membership_id" uuid NOT NULL,
	"service_date" date NOT NULL,
	"sequence_index" integer NOT NULL,
	"from_kind" text NOT NULL,
	"from_visit_id" uuid,
	"from_anchor_location_id" uuid,
	"to_kind" text NOT NULL,
	"to_visit_id" uuid,
	"to_anchor_location_id" uuid,
	"proposed_drive_minutes" integer NOT NULL,
	"proposed_miles" integer NOT NULL,
	"polyline" text,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"optimizer_version" text NOT NULL,
	"version" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "visit" ADD CONSTRAINT "visit_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit" ADD CONSTRAINT "visit_provider_entity_id_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit" ADD CONSTRAINT "visit_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit" ADD CONSTRAINT "visit_assigned_membership_id_membership_id_fk" FOREIGN KEY ("assigned_membership_id") REFERENCES "public"."membership"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_state_history" ADD CONSTRAINT "visit_state_history_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_state_history" ADD CONSTRAINT "visit_state_history_provider_entity_id_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_state_history" ADD CONSTRAINT "visit_state_history_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_visit" ADD CONSTRAINT "recurring_visit_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_visit" ADD CONSTRAINT "recurring_visit_provider_entity_id_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_visit" ADD CONSTRAINT "recurring_visit_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_visit" ADD CONSTRAINT "recurring_visit_assigned_membership_id_membership_id_fk" FOREIGN KEY ("assigned_membership_id") REFERENCES "public"."membership"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_proposal" ADD CONSTRAINT "visit_proposal_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_proposal" ADD CONSTRAINT "visit_proposal_provider_entity_id_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_proposal" ADD CONSTRAINT "visit_proposal_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinician_availability" ADD CONSTRAINT "clinician_availability_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinician_availability" ADD CONSTRAINT "clinician_availability_provider_entity_id_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinician_availability" ADD CONSTRAINT "clinician_availability_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinician_availability" ADD CONSTRAINT "clinician_availability_membership_id_membership_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."membership"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_off" ADD CONSTRAINT "time_off_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_off" ADD CONSTRAINT "time_off_provider_entity_id_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_off" ADD CONSTRAINT "time_off_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_off" ADD CONSTRAINT "time_off_membership_id_membership_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."membership"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "route_segment" ADD CONSTRAINT "route_segment_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "route_segment" ADD CONSTRAINT "route_segment_provider_entity_id_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "route_segment" ADD CONSTRAINT "route_segment_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "route_segment" ADD CONSTRAINT "route_segment_membership_id_membership_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."membership"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "visit_org_location_service_date_idx" ON "visit" USING btree ("organization_id","location_id","service_date");--> statement-breakpoint
CREATE INDEX "visit_org_service_date_idx" ON "visit" USING btree ("organization_id","service_date");--> statement-breakpoint
CREATE INDEX "visit_org_patient_idx" ON "visit" USING btree ("organization_id","patient_id");--> statement-breakpoint
CREATE INDEX "visit_org_membership_idx" ON "visit" USING btree ("organization_id","assigned_membership_id","service_date");--> statement-breakpoint
CREATE INDEX "visit_org_admission_idx" ON "visit" USING btree ("organization_id","admission_id");--> statement-breakpoint
CREATE INDEX "visit_org_status_idx" ON "visit" USING btree ("organization_id","status") WHERE status IN ('proposed','published','en_route','in_visit');--> statement-breakpoint
CREATE INDEX "vsh_visit_at_idx" ON "visit_state_history" USING btree ("visit_id","transitioned_at");--> statement-breakpoint
CREATE INDEX "rv_org_patient_status_idx" ON "recurring_visit" USING btree ("organization_id","patient_id","status");--> statement-breakpoint
CREATE INDEX "vp_org_pending_idx" ON "visit_proposal" USING btree ("organization_id","status","proposed_for_date") WHERE status = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "vp_idempotency_uidx" ON "visit_proposal" USING btree ("organization_id","source","source_idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "ca_membership_day_uidx" ON "clinician_availability" USING btree ("membership_id","day_of_week","effective_start_date");--> statement-breakpoint
CREATE INDEX "to_org_mem_state_idx" ON "time_off" USING btree ("organization_id","membership_id","approval_state");--> statement-breakpoint
CREATE INDEX "to_membership_window_idx" ON "time_off" USING btree ("membership_id","starts_at","ends_at");--> statement-breakpoint
CREATE UNIQUE INDEX "rs_membership_day_seq_uidx" ON "route_segment" USING btree ("membership_id","service_date","sequence_index");