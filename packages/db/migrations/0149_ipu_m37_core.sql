-- M37 Inpatient Unit (IPU) Management §3.2/§3.3 — the 23 enums + the 22 UNPARTITIONED owned tables
-- (the 4 monthly-partitioned tables land in 0150; RLS/grants/audit triggers in 0151). M37 sits at
-- migrations 0149+ — ABOVE M29's unmerged 0144–0148 range (the disjoint-range rule) so whichever of
-- M29/M37 merges first, the other does not collide.
--
-- FK POLICY (D17 outbox-decoupling): every cross-module id (M6 admission/LoC/death, M8 encounter, M11
-- order, M22 document, M40 facility/funeral-home/provider-entity, patient_id) is a LOGICAL uuid — no FK
-- into another module's schema, in either direction. Only intra-module parent links are real FKs.
-- ARCH-011 three-column rule: the patient-bearing tables carry provider_entity_id + location_id
-- (the §3.3 sketch omits them; architecture wins).

-- ============================================================================================
-- Enums (§3.2)
-- ============================================================================================
CREATE TYPE "ipu_room_kind" AS ENUM ('private', 'semi_private', 'family', 'shared_overflow');--> statement-breakpoint
CREATE TYPE "ipu_bed_cleaning_status" AS ENUM ('ready', 'reserved', 'occupied', 'discharged_dirty', 'cleaning', 'retired');--> statement-breakpoint
CREATE TYPE "ipu_admission_kind" AS ENUM ('gip', 'irc', 'arranged');--> statement-breakpoint
CREATE TYPE "ipu_admission_state" AS ENUM ('pending', 'bed_pending', 'bed_assigned', 'active', 'transferring', 'transferred', 'discharged', 'deceased', 'closed');--> statement-breakpoint
CREATE TYPE "ipu_admission_transition_kind" AS ENUM ('to_unit', 'to_home', 'to_facility', 'to_other_hospice', 'revocation', 'expired_benefit');--> statement-breakpoint
CREATE TYPE "ipu_shift_role" AS ENUM ('charge_rn', 'rn', 'np_in_rn_role', 'lpn', 'cna', 'unit_secretary', 'housekeeping', 'pharmacist', 'social_worker_in_unit', 'chaplain_in_unit', 'medical_director_in_unit');--> statement-breakpoint
CREATE TYPE "ipu_shift_assignment_state" AS ENUM ('tentative', 'confirmed', 'cancelled', 'completed', 'no_show');--> statement-breakpoint
CREATE TYPE "gip_criterion_kind" AS ENUM ('acute_symptom_management', 'imminent_death_terminal_care', 'medications_treatments_inpatient_only');--> statement-breakpoint
CREATE TYPE "irc_episode_state" AS ENUM ('active', 'approaching_cap', 'breached', 'closed');--> statement-breakpoint
CREATE TYPE "ipu_restraint_kind" AS ENUM ('soft_limb', 'posey_vest', 'mitt', 'side_rail_4');--> statement-breakpoint
CREATE TYPE "ipu_restraint_event_state" AS ENUM ('active', 'released');--> statement-breakpoint
CREATE TYPE "ipu_restraint_reassessment_outcome" AS ENUM ('continue', 'modify', 'release');--> statement-breakpoint
CREATE TYPE "ipu_visitor_relationship" AS ENUM ('spouse', 'parent', 'child', 'sibling', 'grandparent', 'grandchild', 'in_law', 'aunt_uncle', 'cousin', 'friend', 'clergy', 'volunteer', 'caregiver_paid', 'legal_representative', 'other');--> statement-breakpoint
CREATE TYPE "ipu_visitor_restriction_scope" AS ENUM ('unit', 'patient');--> statement-breakpoint
CREATE TYPE "ipu_visitor_restriction_kind" AS ENUM ('full_block', 'immediate_family_only', 'mask_required', 'time_limited', 'no_overnight');--> statement-breakpoint
CREATE TYPE "ipu_meal_slot" AS ENUM ('breakfast', 'lunch', 'dinner', 'snack');--> statement-breakpoint
CREATE TYPE "ipu_equipment_type" AS ENUM ('hospital_bed', 'oxygen_concentrator', 'suction_machine', 'iv_pump', 'bipap', 'cpap', 'lift', 'scale', 'vitals_monitor', 'comfort_mattress', 'low_air_loss_mattress');--> statement-breakpoint
CREATE TYPE "ipu_equipment_location_kind" AS ENUM ('unit', 'room', 'bed', 'storage', 'sent_for_repair', 'retired');--> statement-breakpoint
CREATE TYPE "ipu_equipment_status" AS ENUM ('active', 'maintenance', 'retired', 'lost', 'sent_for_repair');--> statement-breakpoint
CREATE TYPE "ipu_equipment_inspection_kind" AS ENUM ('annual_biomed', 'per_use_safety', 'post_repair_safety', 'recall_response');--> statement-breakpoint
CREATE TYPE "ipu_equipment_inspection_outcome" AS ENUM ('pass', 'fail', 'conditional_pass', 'retired');--> statement-breakpoint
CREATE TYPE "ipu_body_release_state" AS ENUM ('pending', 'funeral_home_identified', 'released', 'closed');--> statement-breakpoint
CREATE TYPE "ipu_remote_arrangement_billing_basis" AS ENUM ('bundled', 'per_diem_passthrough');--> statement-breakpoint

-- ============================================================================================
-- §2.1 bed hierarchy: inpatient_unit -> ipu_room -> ipu_bed
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "inpatient_unit" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "facility_id" uuid NOT NULL,
  "display_name" text NOT NULL,
  "bed_count" smallint NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "feature_flag_required" text DEFAULT 'ipu_module_enabled' NOT NULL,
  "rn_coverage_horizon_hours" smallint DEFAULT 8 NOT NULL,
  "turnover_sla_minutes" smallint DEFAULT 120 NOT NULL,
  "gip_reassessment_interval_hours" smallint DEFAULT 24 NOT NULL,
  "irc_cap_override_max_days" smallint DEFAULT 2 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "version" bigint DEFAULT 0 NOT NULL,
  CONSTRAINT "inpatient_unit_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "inpatient_unit_bed_count_chk" CHECK ("bed_count" >= 0),
  CONSTRAINT "inpatient_unit_rn_horizon_chk" CHECK ("rn_coverage_horizon_hours" >= 8 AND "rn_coverage_horizon_hours" <= 168),
  CONSTRAINT "inpatient_unit_turnover_chk" CHECK ("turnover_sla_minutes" <= 120),
  CONSTRAINT "inpatient_unit_gip_interval_chk" CHECK ("gip_reassessment_interval_hours" >= 4 AND "gip_reassessment_interval_hours" <= 24),
  CONSTRAINT "inpatient_unit_irc_override_chk" CHECK ("irc_cap_override_max_days" <= 2)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "inpatient_unit_org_facility_uq" ON "inpatient_unit" ("organization_id","facility_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "ipu_room" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "unit_id" uuid NOT NULL,
  "room_number" text NOT NULL,
  "kind" "ipu_room_kind" NOT NULL,
  "bed_count" smallint NOT NULL,
  "has_window" boolean DEFAULT false NOT NULL,
  "has_private_bathroom" boolean DEFAULT false NOT NULL,
  "family_amenities_present" boolean DEFAULT false NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "version" bigint DEFAULT 0 NOT NULL,
  CONSTRAINT "ipu_room_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ipu_room_bed_count_chk" CHECK ("bed_count" >= 0),
  CONSTRAINT "ipu_room_unit_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."inpatient_unit"("id") ON DELETE restrict
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ipu_room_unit_room_uq" ON "ipu_room" ("unit_id","room_number");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "ipu_bed" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "room_id" uuid NOT NULL,
  "unit_id" uuid NOT NULL,
  "bed_label" text NOT NULL,
  "cleaning_status" "ipu_bed_cleaning_status" DEFAULT 'ready' NOT NULL,
  "cleaning_status_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
  "geofence_lat" numeric(10, 7),
  "geofence_lon" numeric(11, 7),
  "geofence_radius_meters" smallint DEFAULT 25,
  "is_active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "version" bigint DEFAULT 0 NOT NULL,
  CONSTRAINT "ipu_bed_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ipu_bed_room_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."ipu_room"("id") ON DELETE restrict,
  CONSTRAINT "ipu_bed_unit_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."inpatient_unit"("id") ON DELETE restrict
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ipu_bed_room_label_uq" ON "ipu_bed" ("room_id","bed_label");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ipu_bed_unit_status_idx" ON "ipu_bed" ("unit_id","cleaning_status") WHERE is_active;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ipu_bed_room_idx" ON "ipu_bed" ("room_id") WHERE is_active;--> statement-breakpoint

-- ============================================================================================
-- §2.2 admission unit-of-work + bed assignment + transition ledger
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "ipu_admission" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "provider_entity_id" uuid NOT NULL,
  "location_id" uuid,
  "patient_id" uuid NOT NULL,
  "admission_id" uuid NOT NULL,
  "level_of_care_period_id" uuid NOT NULL,
  "unit_id" uuid,
  "remote_facility_id" uuid,
  "kind" "ipu_admission_kind" NOT NULL,
  "state" "ipu_admission_state" DEFAULT 'pending' NOT NULL,
  "opened_at" timestamp with time zone DEFAULT now() NOT NULL,
  "bed_assigned_at" timestamp with time zone,
  "activated_at" timestamp with time zone,
  "closed_at" timestamp with time zone,
  "death_event_id" uuid,
  "created_by" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "version" bigint DEFAULT 0 NOT NULL,
  CONSTRAINT "ipu_admission_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ipu_admission_lcp_unique" UNIQUE ("level_of_care_period_id"),
  CONSTRAINT "ipu_admission_unit_xor_remote" CHECK (
    ("kind" = 'arranged' AND "remote_facility_id" IS NOT NULL AND "unit_id" IS NULL)
    OR ("kind" IN ('gip','irc') AND "unit_id" IS NOT NULL AND "remote_facility_id" IS NULL)
  ),
  CONSTRAINT "ipu_admission_unit_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."inpatient_unit"("id") ON DELETE restrict
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ipu_admission_patient_state_idx" ON "ipu_admission" ("patient_id","state") WHERE state NOT IN ('closed');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ipu_admission_unit_state_idx" ON "ipu_admission" ("unit_id","state") WHERE state NOT IN ('closed') AND unit_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ipu_admission_remote_state_idx" ON "ipu_admission" ("remote_facility_id","state") WHERE state NOT IN ('closed') AND remote_facility_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ipu_admission_lcp_idx" ON "ipu_admission" ("level_of_care_period_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "ipu_bed_assignment" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "ipu_admission_id" uuid NOT NULL,
  "bed_id" uuid NOT NULL,
  "assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
  "ended_at" timestamp with time zone,
  "assigned_by" uuid NOT NULL,
  "unassign_reason" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "version" bigint DEFAULT 0 NOT NULL,
  CONSTRAINT "ipu_bed_assignment_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ipu_bed_assignment_admission_fk" FOREIGN KEY ("ipu_admission_id") REFERENCES "public"."ipu_admission"("id") ON DELETE restrict,
  CONSTRAINT "ipu_bed_assignment_bed_fk" FOREIGN KEY ("bed_id") REFERENCES "public"."ipu_bed"("id") ON DELETE restrict
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ipu_bed_assignment_one_active_per_admission_idx" ON "ipu_bed_assignment" ("ipu_admission_id") WHERE ended_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ipu_bed_assignment_one_active_per_bed_idx" ON "ipu_bed_assignment" ("bed_id") WHERE ended_at IS NULL;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "ipu_admission_transition" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "ipu_admission_id" uuid NOT NULL,
  "kind" "ipu_admission_transition_kind" NOT NULL,
  "initiated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp with time zone,
  "destination_unit_id" uuid,
  "destination_facility_id" uuid,
  "reason" text,
  "initiated_by" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "version" bigint DEFAULT 0 NOT NULL,
  CONSTRAINT "ipu_admission_transition_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ipu_admission_transition_admission_fk" FOREIGN KEY ("ipu_admission_id") REFERENCES "public"."ipu_admission"("id") ON DELETE restrict,
  CONSTRAINT "ipu_admission_transition_dest_unit_fk" FOREIGN KEY ("destination_unit_id") REFERENCES "public"."inpatient_unit"("id")
);--> statement-breakpoint

-- ============================================================================================
-- §2.4/§2.5 GIP criteria + IRC cap + arranged-inpatient episode
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "gip_admission_criteria" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "ipu_admission_id" uuid NOT NULL,
  "criterion_kind" "gip_criterion_kind" NOT NULL,
  "data" jsonb NOT NULL,
  "attesting_physician_id" uuid NOT NULL,
  "attesting_membership_id" uuid NOT NULL,
  "attested_at" timestamp with time zone DEFAULT now() NOT NULL,
  "step_up_assertion_id" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "version" bigint DEFAULT 0 NOT NULL,
  CONSTRAINT "gip_admission_criteria_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "gip_criteria_one_per_admission" UNIQUE ("ipu_admission_id"),
  CONSTRAINT "gip_admission_criteria_admission_fk" FOREIGN KEY ("ipu_admission_id") REFERENCES "public"."ipu_admission"("id") ON DELETE restrict
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "gip_criteria_reassessment" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "gip_admission_criteria_id" uuid NOT NULL,
  "ipu_admission_id" uuid NOT NULL,
  "triggered_by_encounter_id" uuid,
  "reassessed_by_membership_id" uuid NOT NULL,
  "criterion_still_met" boolean NOT NULL,
  "rationale" text NOT NULL,
  "assessed_at" timestamp with time zone DEFAULT now() NOT NULL,
  "step_up_assertion_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "version" bigint DEFAULT 0 NOT NULL,
  CONSTRAINT "gip_criteria_reassessment_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "gip_reassessment_rationale_chk" CHECK (char_length("rationale") >= 50),
  CONSTRAINT "gip_reassessment_criteria_fk" FOREIGN KEY ("gip_admission_criteria_id") REFERENCES "public"."gip_admission_criteria"("id") ON DELETE restrict,
  CONSTRAINT "gip_reassessment_admission_fk" FOREIGN KEY ("ipu_admission_id") REFERENCES "public"."ipu_admission"("id") ON DELETE restrict
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "gip_reassessment_admission_at_idx" ON "gip_criteria_reassessment" ("ipu_admission_id","assessed_at");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "irc_episode" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "ipu_admission_id" uuid NOT NULL,
  "provider_entity_id" uuid NOT NULL,
  "location_id" uuid,
  "patient_id" uuid NOT NULL,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expected_end_at" timestamp with time zone NOT NULL,
  "consecutive_day_count" smallint DEFAULT 1 NOT NULL,
  "state" "irc_episode_state" DEFAULT 'active' NOT NULL,
  "cap_override_invoked" boolean DEFAULT false NOT NULL,
  "cap_override_invoked_by" uuid,
  "cap_override_reason" text,
  "cap_override_extension_days" smallint,
  "closed_at" timestamp with time zone,
  "closure_reason" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "version" bigint DEFAULT 0 NOT NULL,
  CONSTRAINT "irc_episode_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "irc_episode_one_per_admission" UNIQUE ("ipu_admission_id"),
  CONSTRAINT "irc_episode_admission_fk" FOREIGN KEY ("ipu_admission_id") REFERENCES "public"."ipu_admission"("id") ON DELETE restrict
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "irc_episode_state_started_idx" ON "irc_episode" ("state","started_at") WHERE state != 'closed';--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "ipu_remote_inpatient_episode" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "ipu_admission_id" uuid NOT NULL,
  "provider_entity_id" uuid NOT NULL,
  "location_id" uuid,
  "patient_id" uuid NOT NULL,
  "level_of_care_period_id" uuid NOT NULL,
  "remote_facility_id" uuid NOT NULL,
  "kind" "ipu_admission_kind" NOT NULL,
  "started_at" timestamp with time zone NOT NULL,
  "ended_at" timestamp with time zone,
  "arrangement_agreement_document_id" uuid,
  "attending_physician_id" uuid,
  "arrangement_billing_basis" "ipu_remote_arrangement_billing_basis" DEFAULT 'bundled' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "version" bigint DEFAULT 0 NOT NULL,
  CONSTRAINT "ipu_remote_inpatient_episode_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "remote_episode_one_per_admission" UNIQUE ("ipu_admission_id"),
  CONSTRAINT "remote_episode_kind_chk" CHECK ("kind" IN ('gip','irc')),
  CONSTRAINT "ipu_remote_episode_admission_fk" FOREIGN KEY ("ipu_admission_id") REFERENCES "public"."ipu_admission"("id") ON DELETE restrict
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "remote_episode_facility_state_idx" ON "ipu_remote_inpatient_episode" ("remote_facility_id","started_at") WHERE ended_at IS NULL;--> statement-breakpoint

-- ============================================================================================
-- §2.3 staffing + RN-coverage invariant
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "ipu_shift" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "unit_id" uuid NOT NULL,
  "shift_start_at" timestamp with time zone NOT NULL,
  "shift_end_at" timestamp with time zone NOT NULL,
  "display_label" text,
  "created_by" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "version" bigint DEFAULT 0 NOT NULL,
  CONSTRAINT "ipu_shift_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ipu_shift_window_valid" CHECK ("shift_end_at" > "shift_start_at"),
  CONSTRAINT "ipu_shift_unit_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."inpatient_unit"("id") ON DELETE restrict
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ipu_shift_unit_start_idx" ON "ipu_shift" ("unit_id","shift_start_at");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "ipu_staff_assignment" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "shift_id" uuid NOT NULL,
  "membership_id" uuid NOT NULL,
  "role" "ipu_shift_role" NOT NULL,
  "state" "ipu_shift_assignment_state" DEFAULT 'tentative' NOT NULL,
  "assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
  "confirmed_at" timestamp with time zone,
  "cancelled_at" timestamp with time zone,
  "cancellation_reason" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "version" bigint DEFAULT 0 NOT NULL,
  CONSTRAINT "ipu_staff_assignment_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ipu_staff_assignment_shift_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."ipu_shift"("id") ON DELETE restrict
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ipu_staff_assignment_shift_role_idx" ON "ipu_staff_assignment" ("shift_id","role") WHERE state IN ('tentative','confirmed');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ipu_staff_assignment_membership_idx" ON "ipu_staff_assignment" ("membership_id") WHERE state IN ('tentative','confirmed');--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "ipu_rn_coverage_window" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "unit_id" uuid NOT NULL,
  "hour_start_at" timestamp with time zone NOT NULL,
  "is_covered" boolean NOT NULL,
  "rn_assignment_ids" uuid[] NOT NULL,
  "computed_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "ipu_rn_coverage_window_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ipu_rn_coverage_unit_hour_uq" UNIQUE ("unit_id","hour_start_at"),
  CONSTRAINT "ipu_rn_coverage_unit_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."inpatient_unit"("id") ON DELETE restrict
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rn_coverage_unit_hour_idx" ON "ipu_rn_coverage_window" ("unit_id","hour_start_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rn_coverage_gap_idx" ON "ipu_rn_coverage_window" ("unit_id","hour_start_at") WHERE is_covered = false;--> statement-breakpoint

-- ============================================================================================
-- §2.5/§2.10 clinical-safety overlays: IV safety (closes M13 deferral) + restraint
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "ipu_iv_safety_overlay" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "ipu_admission_id" uuid NOT NULL,
  "order_id" uuid NOT NULL,
  "medication_rx_norm_code" text NOT NULL,
  "titration_min_rate" numeric(10, 4),
  "titration_max_rate" numeric(10, 4),
  "rate_unit" text NOT NULL,
  "dual_witness_required" boolean DEFAULT false NOT NULL,
  "max_continuous_duration_hours" smallint DEFAULT 168 NOT NULL,
  "bedside_check_interval_minutes" smallint NOT NULL,
  "is_sedation_class" boolean DEFAULT false NOT NULL,
  "overlay_active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "version" bigint DEFAULT 0 NOT NULL,
  CONSTRAINT "ipu_iv_safety_overlay_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "iv_overlay_one_per_order" UNIQUE ("order_id"),
  CONSTRAINT "ipu_iv_safety_overlay_admission_fk" FOREIGN KEY ("ipu_admission_id") REFERENCES "public"."ipu_admission"("id") ON DELETE restrict
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "iv_overlay_admission_idx" ON "ipu_iv_safety_overlay" ("ipu_admission_id") WHERE overlay_active;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "ipu_restraint_event" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "ipu_admission_id" uuid NOT NULL,
  "restraint_kind" "ipu_restraint_kind" NOT NULL,
  "restraint_justification_text" text NOT NULL,
  "ordering_physician_id" uuid NOT NULL,
  "ordering_order_id" uuid NOT NULL,
  "applied_at" timestamp with time zone DEFAULT now() NOT NULL,
  "applied_by_membership_id" uuid NOT NULL,
  "applied_step_up_assertion_id" uuid NOT NULL,
  "reassessment_interval_minutes" smallint NOT NULL,
  "state" "ipu_restraint_event_state" DEFAULT 'active' NOT NULL,
  "released_at" timestamp with time zone,
  "released_by_membership_id" uuid,
  "released_reason" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "version" bigint DEFAULT 0 NOT NULL,
  CONSTRAINT "ipu_restraint_event_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "restraint_justification_chk" CHECK (char_length("restraint_justification_text") >= 100),
  CONSTRAINT "ipu_restraint_event_admission_fk" FOREIGN KEY ("ipu_admission_id") REFERENCES "public"."ipu_admission"("id") ON DELETE restrict
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "restraint_event_admission_state_idx" ON "ipu_restraint_event" ("ipu_admission_id","state") WHERE state = 'active';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "restraint_event_active_idx" ON "ipu_restraint_event" ("applied_at") WHERE state = 'active';--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "ipu_restraint_reassessment" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "restraint_event_id" uuid NOT NULL,
  "reassessed_at" timestamp with time zone DEFAULT now() NOT NULL,
  "reassessed_by_membership_id" uuid NOT NULL,
  "outcome" "ipu_restraint_reassessment_outcome" NOT NULL,
  "notes" text,
  "next_due_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "version" bigint DEFAULT 0 NOT NULL,
  CONSTRAINT "ipu_restraint_reassessment_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ipu_restraint_reassessment_event_fk" FOREIGN KEY ("restraint_event_id") REFERENCES "public"."ipu_restraint_event"("id") ON DELETE restrict
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "restraint_reassessment_event_at_idx" ON "ipu_restraint_reassessment" ("restraint_event_id","reassessed_at");--> statement-breakpoint

-- ============================================================================================
-- §2.7 visitor restriction (visitor itself is partitioned -> 0150)
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "ipu_visitor_restriction" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "provider_entity_id" uuid,
  "location_id" uuid,
  "scope" "ipu_visitor_restriction_scope" NOT NULL,
  "unit_id" uuid,
  "patient_id" uuid,
  "restriction_kind" "ipu_visitor_restriction_kind" NOT NULL,
  "rationale" text NOT NULL,
  "applied_by" uuid NOT NULL,
  "applied_at" timestamp with time zone DEFAULT now() NOT NULL,
  "applied_until" timestamp with time zone,
  "lifted_at" timestamp with time zone,
  "lifted_by" uuid,
  "source_kind" text NOT NULL,
  "source_event_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "version" bigint DEFAULT 0 NOT NULL,
  CONSTRAINT "ipu_visitor_restriction_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "visitor_restriction_scope_check" CHECK (
    ("scope" = 'unit' AND "unit_id" IS NOT NULL AND "patient_id" IS NULL)
    OR ("scope" = 'patient' AND "patient_id" IS NOT NULL)
  ),
  CONSTRAINT "ipu_visitor_restriction_unit_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."inpatient_unit"("id") ON DELETE restrict
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "visitor_restriction_active_unit_idx" ON "ipu_visitor_restriction" ("unit_id") WHERE lifted_at IS NULL AND scope = 'unit';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "visitor_restriction_active_patient_idx" ON "ipu_visitor_restriction" ("patient_id") WHERE lifted_at IS NULL AND scope = 'patient';--> statement-breakpoint

-- ============================================================================================
-- §2.9 equipment + maintenance + inspection
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "ipu_equipment" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "serial_number" text NOT NULL,
  "equipment_type" "ipu_equipment_type" NOT NULL,
  "manufacturer" text NOT NULL,
  "model_number" text NOT NULL,
  "year_of_manufacture" smallint,
  "current_location_kind" "ipu_equipment_location_kind" DEFAULT 'storage' NOT NULL,
  "current_unit_id" uuid,
  "current_room_id" uuid,
  "current_bed_id" uuid,
  "current_assigned_patient_id" uuid,
  "last_inspection_date" date,
  "next_inspection_due_date" date,
  "inspection_interval_days" smallint DEFAULT 365 NOT NULL,
  "current_status" "ipu_equipment_status" DEFAULT 'active' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "version" bigint DEFAULT 0 NOT NULL,
  CONSTRAINT "ipu_equipment_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ipu_equipment_org_serial_uq" UNIQUE ("organization_id","serial_number"),
  CONSTRAINT "ipu_equipment_unit_fk" FOREIGN KEY ("current_unit_id") REFERENCES "public"."inpatient_unit"("id"),
  CONSTRAINT "ipu_equipment_room_fk" FOREIGN KEY ("current_room_id") REFERENCES "public"."ipu_room"("id"),
  CONSTRAINT "ipu_equipment_bed_fk" FOREIGN KEY ("current_bed_id") REFERENCES "public"."ipu_bed"("id")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ipu_equipment_status_idx" ON "ipu_equipment" ("current_status") WHERE current_status = 'active';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ipu_equipment_inspection_due_idx" ON "ipu_equipment" ("next_inspection_due_date") WHERE current_status = 'active';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ipu_equipment_bed_idx" ON "ipu_equipment" ("current_bed_id") WHERE current_assigned_patient_id IS NOT NULL;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "ipu_equipment_maintenance" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "equipment_id" uuid NOT NULL,
  "maintenance_kind" text NOT NULL,
  "performed_at" timestamp with time zone DEFAULT now() NOT NULL,
  "performed_by_membership_id" uuid NOT NULL,
  "notes" text,
  "parts_replaced" jsonb,
  "vendor_invoice_reference" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "version" bigint DEFAULT 0 NOT NULL,
  CONSTRAINT "ipu_equipment_maintenance_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ipu_equipment_maintenance_equipment_fk" FOREIGN KEY ("equipment_id") REFERENCES "public"."ipu_equipment"("id") ON DELETE restrict
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ipu_equipment_maintenance_equipment_idx" ON "ipu_equipment_maintenance" ("equipment_id","performed_at");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "ipu_equipment_inspection" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "equipment_id" uuid NOT NULL,
  "inspection_kind" "ipu_equipment_inspection_kind" NOT NULL,
  "inspected_at" timestamp with time zone DEFAULT now() NOT NULL,
  "inspector_membership_id" uuid NOT NULL,
  "outcome" "ipu_equipment_inspection_outcome" NOT NULL,
  "notes" text,
  "next_inspection_due_date" date NOT NULL,
  "inspection_certificate_document_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "version" bigint DEFAULT 0 NOT NULL,
  CONSTRAINT "ipu_equipment_inspection_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ipu_equipment_inspection_equipment_fk" FOREIGN KEY ("equipment_id") REFERENCES "public"."ipu_equipment"("id") ON DELETE restrict
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ipu_equipment_inspection_equipment_idx" ON "ipu_equipment_inspection" ("equipment_id","inspected_at");--> statement-breakpoint

-- ============================================================================================
-- §2.11/§2.13 body release + daily census
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "ipu_body_release" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "ipu_admission_id" uuid NOT NULL,
  "provider_entity_id" uuid NOT NULL,
  "location_id" uuid,
  "patient_id" uuid NOT NULL,
  "death_event_id" uuid NOT NULL,
  "state" "ipu_body_release_state" DEFAULT 'pending' NOT NULL,
  "pronouncing_physician_id" uuid NOT NULL,
  "pronounced_at" timestamp with time zone NOT NULL,
  "funeral_home_id" uuid,
  "funeral_home_magic_link_session_id" uuid,
  "release_document_id" uuid,
  "released_at" timestamp with time zone,
  "released_to_representative_name" text,
  "released_by_membership_id" uuid,
  "closed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "version" bigint DEFAULT 0 NOT NULL,
  CONSTRAINT "ipu_body_release_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "body_release_one_per_admission" UNIQUE ("ipu_admission_id"),
  CONSTRAINT "ipu_body_release_admission_fk" FOREIGN KEY ("ipu_admission_id") REFERENCES "public"."ipu_admission"("id") ON DELETE restrict
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "body_release_state_pending_idx" ON "ipu_body_release" ("state") WHERE state != 'closed';--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "ipu_census_snapshot" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "service_date" date NOT NULL,
  "unit_id" uuid,
  "remote_facility_id" uuid,
  "provider_entity_id" uuid NOT NULL,
  "census_count_gip" smallint DEFAULT 0 NOT NULL,
  "census_count_irc" smallint DEFAULT 0 NOT NULL,
  "census_count_arranged_gip" smallint DEFAULT 0 NOT NULL,
  "census_count_arranged_irc" smallint DEFAULT 0 NOT NULL,
  "bed_days_gip" smallint DEFAULT 0 NOT NULL,
  "bed_days_irc" smallint DEFAULT 0 NOT NULL,
  "bed_days_arranged_gip" smallint DEFAULT 0 NOT NULL,
  "bed_days_arranged_irc" smallint DEFAULT 0 NOT NULL,
  "room_turnover_count" smallint DEFAULT 0 NOT NULL,
  "restraint_incident_count" smallint DEFAULT 0 NOT NULL,
  "fall_incident_count" smallint DEFAULT 0 NOT NULL,
  "infection_surveillance_event_count" smallint DEFAULT 0 NOT NULL,
  "computed_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "version" bigint DEFAULT 0 NOT NULL,
  CONSTRAINT "ipu_census_snapshot_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "census_snapshot_unit_xor_remote" CHECK (
    ("unit_id" IS NOT NULL AND "remote_facility_id" IS NULL)
    OR ("unit_id" IS NULL AND "remote_facility_id" IS NOT NULL)
  ),
  CONSTRAINT "ipu_census_snapshot_unit_date_uq" UNIQUE ("organization_id","service_date","unit_id","remote_facility_id"),
  CONSTRAINT "ipu_census_snapshot_unit_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."inpatient_unit"("id")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "census_snapshot_pe_date_idx" ON "ipu_census_snapshot" ("provider_entity_id","service_date");
