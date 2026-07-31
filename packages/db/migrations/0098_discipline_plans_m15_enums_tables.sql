-- M15 Discipline Care Plans §3.2/§3.3 — the 13 enum types + the 11 owned tables + their indexes/CHECKs.
-- RLS, grants and the M4 write-audit triggers land in 0099 (M15-T02).
--
-- M15-F06 / ADR-0022 D1.1: NOTHING here is partitioned. Both partition candidates carry partial UNIQUE
-- indexes a partition key would break — discipline_care_plan's one-active-plan-per-(admission, kind) and
-- discipline_assessment's one-signed-initial-per-(plan, kind) — over trivial per-admission volumes.
--
-- TENANCY (M15-F05 / ADR-0010 / ARCH-011): every table carries organization_id NOT NULL. The eight
-- patient-bearing tables also carry provider_entity_id + location_id NOT NULL, denormalized from the
-- admission at bootstrap so the §4.3 compliance seams roll up per PE/location without joining through the
-- M5/M6 schemas. The three volunteer-compliance tables hang off the volunteer membership / provider entity
-- rather than a patient (volunteer_compliance_gate: org only; volunteer_hour_ledger: org + PE;
-- volunteer_hour_entry: org, PE inherited from its ledger parent).
--
-- CROSS-MODULE FK POLICY (architecture wins): only organization_id / provider_entity_id / location_id
-- (M1 core) and intra-M15 parents get real FK constraints. patient_id (M5), admission_id (M6), every
-- membership id (M2), source_encounter_id (M8), idg_meeting_id (M14), source_document_id (M22) and
-- acting_consent_id (M39) are LOGICAL uuid, validated at the write boundary.
CREATE TYPE "public"."discipline_plan_kind" AS ENUM('aide_poc', 'msw_plan', 'spiritual_plan', 'volunteer_plan');--> statement-breakpoint
CREATE TYPE "public"."discipline_plan_status" AS ENUM('draft', 'active', 'draft_revising', 'discharged');--> statement-breakpoint
CREATE TYPE "public"."discipline_plan_version_status" AS ENUM('draft', 'in_review', 'signed', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."discipline_plan_version_kind" AS ENUM('initial', 'idg_review', 'interim_revision', 'discharge');--> statement-breakpoint
CREATE TYPE "public"."discipline_goal_source" AS ENUM('clinical', 'patient_stated', 'family_stated', 'agent_stated');--> statement-breakpoint
CREATE TYPE "public"."discipline_goal_status" AS ENUM('not_started', 'in_progress', 'met', 'not_met', 'revised', 'discontinued');--> statement-breakpoint
CREATE TYPE "public"."discipline_intervention_status" AS ENUM('active', 'discontinued', 'completed');--> statement-breakpoint
CREATE TYPE "public"."discipline_assessment_kind" AS ENUM('msw_psychosocial', 'chaplain_spiritual', 'aide_environmental', 'volunteer_relationship');--> statement-breakpoint
CREATE TYPE "public"."discipline_assessment_status" AS ENUM('draft', 'signed', 'amended');--> statement-breakpoint
CREATE TYPE "public"."aide_supervisory_attestation_mode" AS ENUM('aide_present', 'observation_of_work');--> statement-breakpoint
CREATE TYPE "public"."volunteer_gate_kind" AS ENUM('background_check', 'tb_screening', 'confidentiality_agreement', 'initial_training', 'annual_ce', 'assignment_specific_training', 'vaccination_status');--> statement-breakpoint
CREATE TYPE "public"."volunteer_gate_status" AS ENUM('satisfied', 'expiring_soon', 'expired', 'revoked', 'not_yet_satisfied');--> statement-breakpoint
CREATE TYPE "public"."volunteer_hour_entry_source" AS ENUM('encounter', 'volunteer_admin_hours', 'manual_adjustment');--> statement-breakpoint

-- ============================================================================================
-- discipline_care_plan — the plan ROOT (§2.2.1). One non-discharged row per (admission, kind).
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "discipline_care_plan" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"admission_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"kind" "discipline_plan_kind" NOT NULL,
	"status" "discipline_plan_status" DEFAULT 'draft' NOT NULL,
	"aide_membership_id" uuid,
	"supervising_rn_membership_id" uuid,
	"next_supervisory_due_at" timestamp with time zone,
	"supervisory_cadence_days_override" bigint,
	"initial_assessment_clock_started_at" timestamp with time zone,
	"initial_assessment_signed_at" timestamp with time zone,
	"spiritual_care_declined" text,
	"spiritual_care_declined_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"discharged_at" timestamp with time zone,
	"version" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "discipline_care_plan_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "discipline_care_plan_provider_entity_id_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict,
	CONSTRAINT "discipline_care_plan_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict,
	CONSTRAINT "discipline_care_plan_cadence_override_ck" CHECK ("supervisory_cadence_days_override" IS NULL OR ("supervisory_cadence_days_override" >= 1 AND "supervisory_cadence_days_override" <= 14))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "discipline_care_plan_admission_kind_active_uq" ON "discipline_care_plan" ("organization_id","admission_id","kind") WHERE status <> 'discharged';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "discipline_care_plan_patient_kind_idx" ON "discipline_care_plan" ("organization_id","patient_id","kind","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "discipline_care_plan_supervisory_due_idx" ON "discipline_care_plan" ("organization_id","next_supervisory_due_at") WHERE kind = 'aide_poc' AND status = 'active';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "discipline_care_plan_provider_entity_idx" ON "discipline_care_plan" ("organization_id","provider_entity_id","location_id","kind");--> statement-breakpoint

-- ============================================================================================
-- discipline_care_plan_version — the §2.2.2 version chain; state_snapshot sealed at in_review.
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "discipline_care_plan_version" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"sequence" bigint NOT NULL,
	"status" "discipline_plan_version_status" DEFAULT 'draft' NOT NULL,
	"kind" "discipline_plan_version_kind" NOT NULL,
	"state_snapshot" jsonb,
	"required_signer_set" jsonb,
	"idg_meeting_id" uuid,
	"finalized_at" timestamp with time zone,
	"signed_at" timestamp with time zone,
	"superseded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "discipline_care_plan_version_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "discipline_care_plan_version_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict,
	CONSTRAINT "discipline_care_plan_version_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict,
	CONSTRAINT "discipline_care_plan_version_plan_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."discipline_care_plan"("id") ON DELETE restrict
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "discipline_care_plan_version_plan_sequence_uq" ON "discipline_care_plan_version" ("organization_id","plan_id","sequence");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "discipline_care_plan_version_plan_status_idx" ON "discipline_care_plan_version" ("organization_id","plan_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "discipline_care_plan_version_plan_open_uq" ON "discipline_care_plan_version" ("organization_id","plan_id") WHERE status IN ('draft', 'in_review');--> statement-breakpoint

-- ============================================================================================
-- discipline_care_plan_signature — one row per signer per version (§3.5 D11).
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "discipline_care_plan_signature" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"signer_membership_id" uuid NOT NULL,
	"signer_role" text NOT NULL,
	"is_acknowledgment" boolean DEFAULT false NOT NULL,
	"signed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attestation_text" text NOT NULL,
	"session_class" text,
	"ip_address" text,
	"user_agent" text,
	CONSTRAINT "discipline_care_plan_signature_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "discipline_care_plan_signature_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict,
	CONSTRAINT "discipline_care_plan_signature_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict,
	CONSTRAINT "discipline_care_plan_signature_version_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."discipline_care_plan_version"("id") ON DELETE restrict
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "discipline_care_plan_signature_version_role_uq" ON "discipline_care_plan_signature" ("organization_id","version_id","signer_role");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "discipline_care_plan_signature_version_idx" ON "discipline_care_plan_signature" ("organization_id","version_id","signer_role");--> statement-breakpoint

-- ============================================================================================
-- discipline_goal — authored goals; original_text immutable, agent_stated requires a consent (D5).
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "discipline_goal" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"parent_goal_id" uuid,
	"parent_problem_id" uuid,
	"source" "discipline_goal_source" NOT NULL,
	"status" "discipline_goal_status" DEFAULT 'not_started' NOT NULL,
	"original_text" text NOT NULL,
	"revised_text" text,
	"measurable_outcome" text,
	"target_at" timestamp with time zone,
	"frequency_text" text,
	"frequency_value" text,
	"modality_text" text,
	"sud_related" boolean DEFAULT false NOT NULL,
	"acting_consent_id" uuid,
	"added_by_membership_id" uuid NOT NULL,
	"added_by_discipline" text NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "discipline_goal_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "discipline_goal_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict,
	CONSTRAINT "discipline_goal_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict,
	CONSTRAINT "discipline_goal_plan_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."discipline_care_plan"("id") ON DELETE restrict,
	CONSTRAINT "discipline_goal_original_text_len_ck" CHECK (length("original_text") > 0 AND length("original_text") <= 4000),
	CONSTRAINT "discipline_goal_agent_stated_consent_ck" CHECK ("source" <> 'agent_stated' OR "acting_consent_id" IS NOT NULL)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "discipline_goal_plan_idx" ON "discipline_goal" ("organization_id","plan_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "discipline_goal_parent_goal_idx" ON "discipline_goal" ("parent_goal_id");--> statement-breakpoint

-- ============================================================================================
-- discipline_intervention — what is done, how often, by whom; discontinuation requires a reason.
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "discipline_intervention" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"parent_intervention_id" uuid,
	"goal_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"scope_text" text NOT NULL,
	"frequency_text" text NOT NULL,
	"frequency_value" text NOT NULL,
	"discipline" text NOT NULL,
	"responsible_roles" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "discipline_intervention_status" DEFAULT 'active' NOT NULL,
	"discontinuation_reason" text,
	"added_by_membership_id" uuid NOT NULL,
	"added_by_discipline" text NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "discipline_intervention_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "discipline_intervention_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict,
	CONSTRAINT "discipline_intervention_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict,
	CONSTRAINT "discipline_intervention_plan_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."discipline_care_plan"("id") ON DELETE restrict,
	CONSTRAINT "discipline_intervention_frequency_value_ck" CHECK ("frequency_value" ~ '^([0-9]+:(visit|day|week|month|prn|continuous):(day|week|month|episode|prn))$'),
	CONSTRAINT "discipline_intervention_discontinued_reason_ck" CHECK ("status" <> 'discontinued' OR "discontinuation_reason" IS NOT NULL)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "discipline_intervention_plan_idx" ON "discipline_intervention" ("organization_id","plan_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "discipline_intervention_parent_intervention_idx" ON "discipline_intervention" ("parent_intervention_id");--> statement-breakpoint

-- ============================================================================================
-- discipline_assessment — append-only correction-of-record (M9 D9); sud/family-violence gates.
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "discipline_assessment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"kind" "discipline_assessment_kind" NOT NULL,
	"status" "discipline_assessment_status" DEFAULT 'draft' NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"is_initial" boolean DEFAULT false NOT NULL,
	"sud_flag" boolean DEFAULT false NOT NULL,
	"family_violence_flag" boolean DEFAULT false NOT NULL,
	"source_encounter_id" uuid,
	"data" jsonb NOT NULL,
	"amends_assessment_id" uuid,
	"amendment_reason" text,
	"captured_by_membership_id" uuid NOT NULL,
	"signed_at" timestamp with time zone,
	"signed_by_membership_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "discipline_assessment_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "discipline_assessment_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict,
	CONSTRAINT "discipline_assessment_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict,
	CONSTRAINT "discipline_assessment_plan_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."discipline_care_plan"("id") ON DELETE restrict,
	CONSTRAINT "discipline_assessment_amendment_reason_ck" CHECK ("amends_assessment_id" IS NULL OR "amendment_reason" IS NOT NULL),
	CONSTRAINT "discipline_assessment_signed_signer_ck" CHECK ("status" = 'draft' OR ("signed_at" IS NOT NULL AND "signed_by_membership_id" IS NOT NULL))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "discipline_assessment_plan_kind_idx" ON "discipline_assessment" ("organization_id","plan_id","kind","captured_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "discipline_assessment_initial_uq" ON "discipline_assessment" ("organization_id","plan_id","kind") WHERE is_initial = true AND status = 'signed';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "discipline_assessment_is_initial_idx" ON "discipline_assessment" ("organization_id","plan_id","kind") WHERE is_initial = true;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "discipline_assessment_amends_idx" ON "discipline_assessment" ("amends_assessment_id");--> statement-breakpoint

-- ============================================================================================
-- aide_supervisory_visit — the 42 CFR §418.76(h) RN attestation ledger (§7.1 14-day cadence).
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "aide_supervisory_visit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"aide_membership_id" uuid NOT NULL,
	"supervising_rn_membership_id" uuid NOT NULL,
	"source_encounter_id" uuid,
	"supervisory_at" timestamp with time zone NOT NULL,
	"attestation_mode" "aide_supervisory_attestation_mode" NOT NULL,
	"aide_performance_satisfactory" boolean NOT NULL,
	"corrective_actions" text,
	"supervisory_narrative" text NOT NULL,
	"next_due_at" timestamp with time zone NOT NULL,
	"cadence_days_at_insert" bigint NOT NULL,
	"captured_by_membership_id" uuid NOT NULL,
	"signed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "aide_supervisory_visit_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "aide_supervisory_visit_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict,
	CONSTRAINT "aide_supervisory_visit_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict,
	CONSTRAINT "aide_supervisory_visit_plan_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."discipline_care_plan"("id") ON DELETE restrict,
	CONSTRAINT "aide_supervisory_visit_corrective_actions_ck" CHECK ("aide_performance_satisfactory" = true OR ("corrective_actions" IS NOT NULL AND length("corrective_actions") >= 40)),
	CONSTRAINT "aide_supervisory_visit_cadence_ck" CHECK ("cadence_days_at_insert" >= 1 AND "cadence_days_at_insert" <= 14)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "aide_supervisory_visit_plan_supervisory_idx" ON "aide_supervisory_visit" ("organization_id","plan_id","supervisory_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "aide_supervisory_visit_next_due_idx" ON "aide_supervisory_visit" ("organization_id","next_due_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "aide_supervisory_visit_aide_idx" ON "aide_supervisory_visit" ("aide_membership_id");--> statement-breakpoint

-- ============================================================================================
-- volunteer_assignment — plan × volunteer (§2.2.5); gate expiry inactivates open rows (§7.5).
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "volunteer_assignment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"volunteer_membership_id" uuid NOT NULL,
	"coordinator_membership_id" uuid NOT NULL,
	"activities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone,
	"coordinator_acknowledged_at" timestamp with time zone,
	"inactivated_at" timestamp with time zone,
	"inactivation_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "volunteer_assignment_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "volunteer_assignment_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict,
	CONSTRAINT "volunteer_assignment_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict,
	CONSTRAINT "volunteer_assignment_plan_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."discipline_care_plan"("id") ON DELETE restrict
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "volunteer_assignment_plan_volunteer_active_uq" ON "volunteer_assignment" ("organization_id","plan_id","volunteer_membership_id") WHERE inactivated_at IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "volunteer_assignment_volunteer_open_idx" ON "volunteer_assignment" ("organization_id","volunteer_membership_id") WHERE inactivated_at IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "volunteer_assignment_volunteer_idx" ON "volunteer_assignment" ("volunteer_membership_id");--> statement-breakpoint

-- ============================================================================================
-- volunteer_compliance_gate — per (volunteer × gate kind × window); §418.78(b)/(d). Org-scoped
-- staff-compliance row (no patient reference) → no PE/location columns.
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "volunteer_compliance_gate" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"volunteer_membership_id" uuid NOT NULL,
	"gate_kind" "volunteer_gate_kind" NOT NULL,
	"status" "volunteer_gate_status" NOT NULL,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_until" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	"source_document_id" uuid,
	"recorded_by_membership_id" uuid NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "volunteer_compliance_gate_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "volunteer_compliance_gate_valid_window_ck" CHECK ("valid_until" IS NULL OR "valid_until" > "valid_from"),
	CONSTRAINT "volunteer_compliance_gate_revoked_reason_ck" CHECK ("revoked_at" IS NULL OR "revoked_reason" IS NOT NULL)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "volunteer_compliance_gate_current_uq" ON "volunteer_compliance_gate" ("organization_id","volunteer_membership_id","gate_kind") WHERE revoked_at IS NULL AND status <> 'expired';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "volunteer_compliance_gate_expiring_idx" ON "volunteer_compliance_gate" ("organization_id","valid_until") WHERE status IN ('satisfied','expiring_soon');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "volunteer_compliance_gate_volunteer_status_idx" ON "volunteer_compliance_gate" ("organization_id","volunteer_membership_id","status");--> statement-breakpoint

-- ============================================================================================
-- volunteer_hour_ledger — the §418.78(e) 5% ratio NUMERATOR, one row per (PE, fiscal year).
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "volunteer_hour_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"fiscal_year" bigint NOT NULL,
	"total_volunteer_hour_minutes" bigint DEFAULT 0 NOT NULL,
	"as_of_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "volunteer_hour_ledger_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "volunteer_hour_ledger_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict,
	CONSTRAINT "volunteer_hour_ledger_minutes_ck" CHECK ("total_volunteer_hour_minutes" >= 0),
	CONSTRAINT "volunteer_hour_ledger_fiscal_year_ck" CHECK ("fiscal_year" BETWEEN 2000 AND 2200)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "volunteer_hour_ledger_pe_fy_uq" ON "volunteer_hour_ledger" ("organization_id","provider_entity_id","fiscal_year");--> statement-breakpoint

-- ============================================================================================
-- volunteer_hour_entry — append-only ledger line items (§2.2.7 / M15-F04 typed sources).
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "volunteer_hour_entry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"ledger_id" uuid NOT NULL,
	"source_encounter_id" uuid,
	"volunteer_membership_id" uuid NOT NULL,
	"source" "volunteer_hour_entry_source" NOT NULL,
	"duration_minutes" bigint NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"adjustment_reason" text,
	"adjusted_by_membership_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "volunteer_hour_entry_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "volunteer_hour_entry_ledger_id_fk" FOREIGN KEY ("ledger_id") REFERENCES "public"."volunteer_hour_ledger"("id") ON DELETE restrict,
	CONSTRAINT "volunteer_hour_entry_adjustment_reason_ck" CHECK ("source" <> 'manual_adjustment' OR ("adjustment_reason" IS NOT NULL AND "adjusted_by_membership_id" IS NOT NULL)),
	CONSTRAINT "volunteer_hour_entry_duration_ck" CHECK ("duration_minutes" <> 0)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "volunteer_hour_entry_ledger_occurred_idx" ON "volunteer_hour_entry" ("organization_id","ledger_id","occurred_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "volunteer_hour_entry_volunteer_idx" ON "volunteer_hour_entry" ("volunteer_membership_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "volunteer_hour_entry_source_ref_idx" ON "volunteer_hour_entry" ("source_encounter_id");
