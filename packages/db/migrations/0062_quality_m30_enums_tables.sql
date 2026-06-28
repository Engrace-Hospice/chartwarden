-- M30 HQRP & Quality §3.3 — enums + the 14 NON-partitioned owned tables (hand-written SQL mirroring
-- packages/db/src/schema/quality/*.ts). The 4 monthly-partitioned PHI tables (cahps_decedent_sample,
-- incident_report, mortality_review, infection_surveillance_event) land in companion migrations
-- 0063–0066 (one per table; check-ddl-legality rule 1 keys on a SINGLE partition column per file, so the
-- four different RANGE keys must not co-habit a file). RLS + grants land in 0067; the M4 write-audit
-- triggers in 0068.
--
-- ALL 13 M30 enums are created HERE (0062 runs first) so the partition-table migrations can reference
-- m30_cahps_sample_status / m30_incident_* / m30_mortality_review_status by name.
--
-- Tenancy (§3.5 M30-F02 / ADR-0010, CANONICAL): EVERY M30 table carries organization_id uuid NOT NULL
-- (FK → organization) so the canonical app.org_id RLS predicate applies directly — NONE are org-less,
-- so NONE are on the check-tenancy NON_ORG_SCOPED allowlist. Only the org spine + intra-M30 parents
-- (qapi_program, qapi_indicator, qapi_project, sra_cycle, sra_finding) take SQL FKs; every cross-module
-- reference (provider_entity_id, patient_id, admission_id, *_membership_id, document_id, linked_*_id) is
-- a plain uuid (app-validated, no FK), matching the mdm/evv cross-module-ref convention.
CREATE TYPE "public"."m30_measure_period_kind" AS ENUM('rolling_12m_to_quarter', 'calendar_quarter', 'calendar_year', 'cap_year_overlay');--> statement-breakpoint
CREATE TYPE "public"."m30_cahps_sample_status" AS ENUM('pending_export', 'exported_to_vendor', 'vendor_acked', 'export_failed');--> statement-breakpoint
CREATE TYPE "public"."m30_qapi_project_status" AS ENUM('proposed', 'active', 'corrective_action', 'completed', 'abandoned');--> statement-breakpoint
CREATE TYPE "public"."m30_qapi_pip_status" AS ENUM('chartering', 'root_cause_analysis', 'intervention_in_progress', 'measurement', 'concluded', 'suspended');--> statement-breakpoint
CREATE TYPE "public"."m30_sra_cycle_status" AS ENUM('chartered', 'in_progress', 'review', 'closed', 'reopened');--> statement-breakpoint
CREATE TYPE "public"."m30_sra_finding_status" AS ENUM('identified', 'analyzed', 'mitigation_planned', 'mitigation_in_progress', 'mitigated', 'accepted_risk');--> statement-breakpoint
CREATE TYPE "public"."m30_sra_remediation_status" AS ENUM('proposed', 'in_progress', 'completed', 'abandoned');--> statement-breakpoint
CREATE TYPE "public"."m30_cop_status" AS ENUM('compliant', 'at_risk', 'deficient');--> statement-breakpoint
CREATE TYPE "public"."m30_incident_kind" AS ENUM('fall', 'medication_error', 'complaint', 'allegation_of_abuse', 'exposure_event', 'other_safety_event');--> statement-breakpoint
CREATE TYPE "public"."m30_incident_severity" AS ENUM('minor', 'moderate', 'severe', 'critical');--> statement-breakpoint
CREATE TYPE "public"."m30_incident_lifecycle" AS ENUM('draft', 'submitted', 'triaged', 'under_investigation', 'resolved', 'closed_followup_complete', 'reopened');--> statement-breakpoint
CREATE TYPE "public"."m30_mortality_review_status" AS ENUM('pending', 'in_progress', 'completed', 'overdue');--> statement-breakpoint
CREATE TYPE "public"."m30_outbreak_status" AS ENUM('open', 'idg_reviewed', 'contained', 'closed');--> statement-breakpoint
-- ============================================================================================
-- measures subdomain (5 tables; cahps_decedent_sample is partitioned → 0066). 4 land here.
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "quality_measure_value" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"measure_code" text NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"period_kind" "m30_measure_period_kind" NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"numerator" integer NOT NULL,
	"denominator" integer NOT NULL,
	"ratio" numeric(6, 4),
	"threshold_met" boolean,
	"computation_snapshot" jsonb NOT NULL,
	"snapshot_content_hash" text NOT NULL,
	"calculator_version" text NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"computed_by" text DEFAULT 'worker:measure-recompute' NOT NULL,
	"superseded_at" timestamp with time zone,
	"superseded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "quality_measure_value_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "measure_recompute_queue" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"measure_code" text NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"requires_recompute" boolean DEFAULT true NOT NULL,
	"triggering_event_outbox_id" uuid,
	"triggering_event_name" text,
	"enqueued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "measure_recompute_queue_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cahps_vendor_binding" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"vendor_adapter_id" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_until" timestamp with time zone,
	"configuration_cipher" text NOT NULL,
	"configuration_key_version" integer NOT NULL,
	"size_exemption_flag" boolean DEFAULT false NOT NULL,
	"size_exemption_last_determined_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "cahps_vendor_binding_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cahps_result_summary" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"reporting_period_start" date NOT NULL,
	"reporting_period_end" date NOT NULL,
	"vendor_adapter_id" text NOT NULL,
	"top_box_percentages" jsonb NOT NULL,
	"composite_scores" jsonb NOT NULL,
	"response_count" integer NOT NULL,
	"attempted_sample_count" integer NOT NULL,
	"response_rate" numeric(5, 4),
	"vendor_response_payload_hash" text NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cahps_result_summary_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict
);
--> statement-breakpoint
-- ============================================================================================
-- compliance-program subdomain (9 tables; all non-partitioned). qapi_program is the parent of
-- indicator/project/pip/minutes; sra_cycle → sra_finding → sra_remediation. Created in FK order.
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "qapi_program" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"plan_year" integer NOT NULL,
	"program_description" text NOT NULL,
	"governing_body_roster" jsonb NOT NULL,
	"year_end_attestation" jsonb,
	"closed" boolean DEFAULT false NOT NULL,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "qapi_program_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "qapi_indicator" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"qapi_program_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"indicator_name" text NOT NULL,
	"data_path" text NOT NULL,
	"tenant_target_value" numeric(10, 4),
	"baseline_value" numeric(10, 4),
	"baseline_at" timestamp with time zone,
	"tracking_frequency" text DEFAULT 'monthly' NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "qapi_indicator_qapi_program_id_qapi_program_id_fk" FOREIGN KEY ("qapi_program_id") REFERENCES "public"."qapi_program"("id") ON DELETE restrict,
	CONSTRAINT "qapi_indicator_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "qapi_project" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"qapi_program_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"title" text NOT NULL,
	"goal_text" text NOT NULL,
	"owner_membership_id" uuid NOT NULL,
	"linked_indicator_id" uuid,
	"baseline_value" numeric(10, 4),
	"target_value" numeric(10, 4),
	"timeline_start" date,
	"timeline_target_end" date,
	"status" "m30_qapi_project_status" DEFAULT 'proposed' NOT NULL,
	"outcome_text" text,
	"abandon_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "qapi_project_qapi_program_id_qapi_program_id_fk" FOREIGN KEY ("qapi_program_id") REFERENCES "public"."qapi_program"("id") ON DELETE restrict,
	CONSTRAINT "qapi_project_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "qapi_project_linked_indicator_id_qapi_indicator_id_fk" FOREIGN KEY ("linked_indicator_id") REFERENCES "public"."qapi_indicator"("id") ON DELETE restrict
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "qapi_pip" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"qapi_program_id" uuid NOT NULL,
	"linked_project_id" uuid,
	"organization_id" uuid NOT NULL,
	"title" text NOT NULL,
	"charter_text" text NOT NULL,
	"root_cause_analysis_text" text,
	"intervention_plan_text" text,
	"measurement_plan_text" text,
	"conclusion_text" text,
	"status" "m30_qapi_pip_status" DEFAULT 'chartering' NOT NULL,
	"cosign_qapi_coordinator_at" timestamp with time zone,
	"cosign_qapi_coordinator_membership_id" uuid,
	"cosign_medical_director_at" timestamp with time zone,
	"cosign_medical_director_membership_id" uuid,
	"closed_at" timestamp with time zone,
	"suspend_reason" text,
	"document_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "qapi_pip_qapi_program_id_qapi_program_id_fk" FOREIGN KEY ("qapi_program_id") REFERENCES "public"."qapi_program"("id") ON DELETE restrict,
	CONSTRAINT "qapi_pip_linked_project_id_qapi_project_id_fk" FOREIGN KEY ("linked_project_id") REFERENCES "public"."qapi_project"("id") ON DELETE restrict,
	CONSTRAINT "qapi_pip_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "chk_qapi_pip_closure_cosign" CHECK ((closed_at IS NULL) OR (cosign_qapi_coordinator_at IS NOT NULL AND cosign_medical_director_at IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "qapi_governance_minutes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"qapi_program_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"meeting_at" timestamp with time zone NOT NULL,
	"attendee_roster" jsonb NOT NULL,
	"minutes_text" text NOT NULL,
	"reviewed_project_ids" jsonb NOT NULL,
	"reviewed_pip_ids" jsonb NOT NULL,
	"signed" boolean DEFAULT false NOT NULL,
	"signed_at" timestamp with time zone,
	"signed_by_membership_id" uuid,
	"document_id" uuid,
	"amendment_log" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "qapi_governance_minutes_qapi_program_id_qapi_program_id_fk" FOREIGN KEY ("qapi_program_id") REFERENCES "public"."qapi_program"("id") ON DELETE restrict,
	CONSTRAINT "qapi_governance_minutes_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sra_cycle" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"cycle_year" integer NOT NULL,
	"status" "m30_sra_cycle_status" DEFAULT 'chartered' NOT NULL,
	"template_version" text DEFAULT 'nist_800_66_r2' NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"opened_by_membership_id" uuid NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"cosign_security_officer_at" timestamp with time zone,
	"cosign_security_officer_membership_id" uuid,
	"cosign_compliance_officer_at" timestamp with time zone,
	"cosign_compliance_officer_membership_id" uuid,
	"closed_at" timestamp with time zone,
	"reopened_at" timestamp with time zone,
	"reopen_reason" text,
	"reopen_count" integer DEFAULT 0 NOT NULL,
	"document_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "sra_cycle_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "chk_sra_cycle_closure_cosign" CHECK ((closed_at IS NULL) OR (cosign_security_officer_at IS NOT NULL AND cosign_compliance_officer_at IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sra_finding" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sra_cycle_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"finding_number" integer NOT NULL,
	"threat_description" text NOT NULL,
	"vulnerability_description" text NOT NULL,
	"impact_description" text NOT NULL,
	"affected_asset_category" text NOT NULL,
	"inherent_5x5_score" integer NOT NULL,
	"residual_5x5_score" integer NOT NULL,
	"status" "m30_sra_finding_status" DEFAULT 'identified' NOT NULL,
	"accepted_risk_attestation_at" timestamp with time zone,
	"accepted_risk_attestation_membership_id" uuid,
	"accepted_risk_auto_reopen_at" timestamp with time zone,
	"carried_from_prior_cycle_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "sra_finding_sra_cycle_id_sra_cycle_id_fk" FOREIGN KEY ("sra_cycle_id") REFERENCES "public"."sra_cycle"("id") ON DELETE restrict,
	CONSTRAINT "sra_finding_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sra_remediation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sra_finding_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"remediation_number" integer NOT NULL,
	"owner_membership_id" uuid NOT NULL,
	"description_text" text NOT NULL,
	"target_date" date NOT NULL,
	"status" "m30_sra_remediation_status" DEFAULT 'proposed' NOT NULL,
	"completed_at" timestamp with time zone,
	"evidence_document_id" uuid,
	"abandon_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "sra_remediation_sra_finding_id_sra_finding_id_fk" FOREIGN KEY ("sra_finding_id") REFERENCES "public"."sra_finding"("id") ON DELETE restrict,
	CONSTRAINT "sra_remediation_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cop_compliance_status" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"cop_citation" text NOT NULL,
	"status" "m30_cop_status" NOT NULL,
	"evidence_document_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"self_assessment_notes" text,
	"last_reviewed_at" timestamp with time zone NOT NULL,
	"last_reviewed_by_membership_id" uuid NOT NULL,
	"next_review_due_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "cop_compliance_status_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict
);
--> statement-breakpoint
-- ============================================================================================
-- safety-surveillance subdomain — the only NON-partitioned member: infection_outbreak_case (the
-- aggregate cluster; no patient_id, server-created only). The other three are partitioned (0063–0065).
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "infection_outbreak_case" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"pathogen" text NOT NULL,
	"body_site" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"triggering_event_count" integer NOT NULL,
	"status" "m30_outbreak_status" DEFAULT 'open' NOT NULL,
	"idg_review_required_at" timestamp with time zone,
	"idg_reviewed_at" timestamp with time zone,
	"contained_at" timestamp with time zone,
	"contained_attestation_membership_id" uuid,
	"next_monitoring_due_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "infection_outbreak_case_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict
);
--> statement-breakpoint
-- ---- indexes (§3.4) ----
CREATE UNIQUE INDEX IF NOT EXISTS "uq_quality_measure_value_current" ON "quality_measure_value" ("measure_code","provider_entity_id","period_start","period_end") WHERE superseded_at IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_quality_measure_value_by_period" ON "quality_measure_value" ("provider_entity_id","measure_code","period_end");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_measure_recompute_pending" ON "measure_recompute_queue" ("measure_code","provider_entity_id","period_start","period_end") WHERE requires_recompute = true;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_cahps_binding_active_per_org" ON "cahps_vendor_binding" ("organization_id") WHERE active = true;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_cahps_result_idempotent" ON "cahps_result_summary" ("provider_entity_id","vendor_adapter_id","reporting_period_start","reporting_period_end","vendor_response_payload_hash");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_qapi_program_year" ON "qapi_program" ("organization_id","plan_year");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_sra_cycle_year" ON "sra_cycle" ("organization_id","cycle_year");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_sra_finding_in_cycle" ON "sra_finding" ("sra_cycle_id","finding_number");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_cop_compliance_citation" ON "cop_compliance_status" ("provider_entity_id","cop_citation");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_outbreak_window" ON "infection_outbreak_case" ("provider_entity_id","pathogen","body_site","window_start","window_end");
