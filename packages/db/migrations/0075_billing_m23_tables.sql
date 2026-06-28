-- M23 Billing — Medicare §3.3 — the 13 NON-partitioned owned tables (the other four —
-- claim (0074), claim_state_history / validation_run / validation_result (0076) — are partitioned and
-- live in their own files per check-ddl-legality rule 1). NONE of these declare PARTITION BY, so the
-- single-partition-column-per-file rule does not apply here. Created AFTER claim (0074) and AFTER
-- claim_submission (created first in THIS file, before claim_acknowledgment which FKs it) so all FK
-- targets exist by lexical apply order.
--
-- FK CONVENTION (M27 precedent): organization_id → organization (ON DELETE restrict) is the only real
-- cross-module FK. Intra-M23 FK to a partitioned table (claim, validation_run, validation_result) is a
-- LOGICAL FK (plain uuid, no SQL FK — the composite PK on those parents cannot be a single-column FK
-- target). Intra-M23 FK to a NON-partitioned table (claim_submission) is a real SQL FK. Every cross-
-- module reference (provider_entity_id, patient_id, admission_id, *_membership_id, *_event_id, M22
-- document ids, M25 remittance id) is a plain uuid (app-validated). MBI is NEVER a column anywhere (D13).
--
-- wage_index_factor is the one PLATFORM-SHARED table (D12): NO organization_id. Its RLS/grants are
-- isolated in 0078 (read-all + platform-loader-only write); it is intentionally NOT in the 0077 org-RLS
-- set. (Its Drizzle schema must be added to check-tenancy NON_ORG_SCOPED — a companion code change.)

-- ============================================================================================
-- claim_line — internal-write-only (assembly service). claim_id LOGICAL (claim is partitioned).
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "claim_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"claim_id" uuid NOT NULL,
	"line_number" integer NOT NULL,
	"revenue_code" "claim_line_revenue_code" NOT NULL,
	"q_code" "claim_line_q_code" NOT NULL,
	"level_of_care" "claim_line_level_of_care" NOT NULL,
	"hcpcs_code" text,
	"service_date_from" date NOT NULL,
	"service_date_to" date NOT NULL,
	"unit_count" integer NOT NULL,
	"unit_rate_cents" bigint NOT NULL,
	"line_charge_cents" bigint NOT NULL,
	"level_of_care_period_id" uuid NOT NULL,
	"backing_encounter_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"icd_pointer_positions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"modifiers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "claim_line_unique_line_uq" UNIQUE("claim_id","line_number"),
	CONSTRAINT "claim_line_service_date_in_range" CHECK ("service_date_to" >= "service_date_from"),
	CONSTRAINT "claim_line_unit_positive" CHECK ("unit_count" > 0 AND "unit_rate_cents" >= 0),
	CONSTRAINT "claim_line_charge_matches" CHECK ("line_charge_cents" = "unit_count" * "unit_rate_cents"),
	CONSTRAINT "claim_line_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "claim_line_claim_idx" ON "claim_line" ("claim_id","line_number");--> statement-breakpoint

-- ============================================================================================
-- claim_submission — append-only; one row per dispatch attempt. NON-partitioned (FK target for ack).
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "claim_submission" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"kind" "claim_submission_kind" NOT NULL,
	"claim_id" uuid,
	"noe_id" uuid,
	"notr_id" uuid,
	"claim_control_number" text NOT NULL,
	"attempt_index" integer NOT NULL,
	"outcome" "claim_submission_outcome" DEFAULT 'queued' NOT NULL,
	"outcome_reason" text,
	"generated_file_uri" text,
	"submitted_at" timestamp with time zone,
	"worker_correlation_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "claim_submission_control_attempt_uq" UNIQUE("provider_entity_id","claim_control_number","attempt_index"),
	CONSTRAINT "claim_submission_exactly_one_subject" CHECK (("claim_id" IS NOT NULL)::int + ("noe_id" IS NOT NULL)::int + ("notr_id" IS NOT NULL)::int = 1),
	CONSTRAINT "claim_submission_kind_matches_subject" CHECK (
		("kind" = 'claim_837i' AND "claim_id" IS NOT NULL) OR
		("kind" = 'noe' AND "noe_id" IS NOT NULL) OR
		("kind" = 'notr' AND "notr_id" IS NOT NULL)
	),
	CONSTRAINT "claim_submission_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "claim_submission_claim_idx" ON "claim_submission" ("claim_id") WHERE claim_id IS NOT NULL;--> statement-breakpoint

-- ============================================================================================
-- claim_acknowledgment — append-only; submission_id is a REAL FK (claim_submission non-partitioned).
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "claim_acknowledgment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"submission_id" uuid NOT NULL,
	"claim_id" uuid,
	"kind" "claim_acknowledgment_kind" NOT NULL,
	"mac_jurisdiction" "mac_jurisdiction" NOT NULL,
	"ack_file_uri" text NOT NULL,
	"ack_received_at" timestamp with time zone NOT NULL,
	"parsed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"parsed_payload" jsonb NOT NULL,
	"outcome_status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "claim_ack_file_uq" UNIQUE("mac_jurisdiction","ack_file_uri"),
	CONSTRAINT "claim_acknowledgment_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "claim_acknowledgment_submission_id_claim_submission_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."claim_submission"("id") ON DELETE restrict
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "claim_ack_claim_recent_idx" ON "claim_acknowledgment" ("claim_id","ack_received_at") WHERE claim_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "claim_ack_submission_idx" ON "claim_acknowledgment" ("submission_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "claim_acknowledgment_outcome_partial" ON "claim_acknowledgment" ("organization_id","claim_id","outcome_status") WHERE outcome_status IN ('rejected','partial','denied');--> statement-breakpoint

-- ============================================================================================
-- noe_record (D3) — first-class NOE entity; 5-day window watchdog.
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "noe_record" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"admission_id" uuid NOT NULL,
	"election_period_id" uuid NOT NULL,
	"state" "noe_state" DEFAULT 'DRAFT' NOT NULL,
	"election_effective_date" date NOT NULL,
	"window_target_at" date NOT NULL,
	"window_breached_at" date,
	"noe_control_number" text NOT NULL,
	"payer_noe_control_number" text,
	"latest_submission_id" uuid,
	"latest_acknowledgment_id" uuid,
	"confirmation_document_id" uuid,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "noe_control_number_uq" UNIQUE("provider_entity_id","noe_control_number"),
	CONSTRAINT "noe_record_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "noe_record_admission_uq" ON "noe_record" ("admission_id") WHERE state NOT IN ('CANCELLED','ACK_REJECTED');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "noe_window_watch_idx" ON "noe_record" ("organization_id","state","window_target_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "noe_window_watch_partial" ON "noe_record" ("organization_id","state","window_target_at") WHERE state NOT IN ('ACK_ACCEPTED','CANCELLED','ACK_REJECTED');--> statement-breakpoint

-- ============================================================================================
-- notr_record (D3) — first-class NOTR entity (revocation / transfer_out / discharge trigger).
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "notr_record" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"admission_id" uuid NOT NULL,
	"trigger_kind" "notr_trigger_kind" NOT NULL,
	"revocation_event_id" uuid,
	"transfer_event_id" uuid,
	"discharge_event_id" uuid,
	"effective_end_date" date NOT NULL,
	"window_target_at" date NOT NULL,
	"window_breached_at" date,
	"state" "notr_state" DEFAULT 'DRAFT' NOT NULL,
	"notr_control_number" text NOT NULL,
	"payer_notr_control_number" text,
	"latest_submission_id" uuid,
	"latest_acknowledgment_id" uuid,
	"confirmation_document_id" uuid,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notr_control_number_uq" UNIQUE("provider_entity_id","notr_control_number"),
	CONSTRAINT "notr_one_event_kind" CHECK (
		("revocation_event_id" IS NOT NULL)::int + ("transfer_event_id" IS NOT NULL)::int + ("discharge_event_id" IS NOT NULL)::int = 1
	),
	CONSTRAINT "notr_trigger_matches_event" CHECK (
		("trigger_kind" = 'revocation' AND "revocation_event_id" IS NOT NULL) OR
		("trigger_kind" = 'transfer_out' AND "transfer_event_id" IS NOT NULL) OR
		("trigger_kind" = 'discharge' AND "discharge_event_id" IS NOT NULL)
	),
	CONSTRAINT "notr_record_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "notr_unique_by_event_uq" ON "notr_record" ("revocation_event_id","transfer_event_id","discharge_event_id") WHERE state NOT IN ('CANCELLED','ACK_REJECTED');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notr_window_watch_idx" ON "notr_record" ("organization_id","state","window_target_at");--> statement-breakpoint

-- ============================================================================================
-- hipps_calculation (D7) — append-only; 1:1 with claim; wage-index SNAPSHOTTED for reproducibility.
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "hipps_calculation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"claim_id" uuid NOT NULL,
	"hipps_code" text NOT NULL,
	"hipps_rate_cents" bigint NOT NULL,
	"wage_index_ccn" text NOT NULL,
	"wage_index_fiscal_year" integer NOT NULL,
	"wage_index_factor" text NOT NULL,
	"segments" jsonb NOT NULL,
	"rhc_days_1_to_7" integer DEFAULT 0 NOT NULL,
	"rhc_days_8_plus" integer DEFAULT 0 NOT NULL,
	"calculated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hipps_calculation_claim_uq" UNIQUE("claim_id"),
	CONSTRAINT "hipps_calculation_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hipps_calculation_ccn_fy" ON "hipps_calculation" ("wage_index_ccn","wage_index_fiscal_year");--> statement-breakpoint

-- ============================================================================================
-- sia_calculation (D6) — append-only; 0..1 with claim (only last-7-days-of-life claims).
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "sia_calculation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"claim_id" uuid NOT NULL,
	"patient_deceased_date" date NOT NULL,
	"window_start" date NOT NULL,
	"qualifying_visits" jsonb NOT NULL,
	"total_qualifying_minutes" integer NOT NULL,
	"sia_add_on_cents" bigint NOT NULL,
	"calculated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sia_calculation_claim_uq" UNIQUE("claim_id"),
	CONSTRAINT "sia_calculation_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict
);--> statement-breakpoint

-- ============================================================================================
-- validation_rule_config (D1, D5) — tenant overlay on the platform rule registry. CHECK floor (D5).
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "validation_rule_config" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"rule_key" text NOT NULL,
	"rule_version" integer DEFAULT 1 NOT NULL,
	"is_custom" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"severity" "validation_severity" NOT NULL,
	"override_role_required" "override_role_required" DEFAULT 'billing_manager' NOT NULL,
	"parameters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"regulatory_required_snapshot" boolean DEFAULT false NOT NULL,
	"predicate_dsl" jsonb,
	"set_by_membership_id" uuid NOT NULL,
	"set_reason" text,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "validation_rule_config_org_rule_uq" UNIQUE("organization_id","rule_key"),
	CONSTRAINT "validation_rule_config_non_regulatory_only" CHECK ("regulatory_required_snapshot" IS DISTINCT FROM true),
	CONSTRAINT "validation_rule_config_disable_reason_floor" CHECK ("enabled" OR length(coalesce("set_reason",'')) >= 20),
	CONSTRAINT "validation_rule_config_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict
);--> statement-breakpoint

-- ============================================================================================
-- validation_override (D1) — append-only; one per overridden failed result. result_id LOGICAL
-- (validation_result is partitioned). reason ≥ 40 chars; M4 audit-event linkage.
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "validation_override" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"result_id" uuid NOT NULL,
	"override_membership_id" uuid NOT NULL,
	"override_role_applied" "override_role_required" NOT NULL,
	"reason" text NOT NULL,
	"m4_audit_event_id" uuid NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "validation_override_result_uq" UNIQUE("result_id"),
	CONSTRAINT "validation_override_reason_floor" CHECK (length("reason") >= 40),
	CONSTRAINT "validation_override_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict
);--> statement-breakpoint

-- ============================================================================================
-- sequestration_policy (D11) — per-PE, per-effective-range; tenant FORWARD-ONLY CHECK. The platform
-- baseline (2%) is applied per-provider-entity at onboarding through a platform-loader SECURITY DEFINER
-- path (NOT a global org-NULL row — organization_id is NOT NULL), so 0080 seeds NO row here.
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "sequestration_policy" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"percentage" text NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"set_by_membership_id" uuid NOT NULL,
	"set_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sequestration_policy_forward_only" CHECK ("effective_from" > CURRENT_DATE OR "effective_to" IS NOT NULL),
	CONSTRAINT "sequestration_policy_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sequestration_policy_active_uq" ON "sequestration_policy" ("provider_entity_id","effective_from") WHERE effective_to IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sequestration_policy_by_pe_idx" ON "sequestration_policy" ("provider_entity_id","effective_from");--> statement-breakpoint

-- ============================================================================================
-- wage_index_factor (D12) — PLATFORM-SHARED reference, NO organization_id. RLS/grants isolated in 0078.
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "wage_index_factor" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ccn" text NOT NULL,
	"fiscal_year_starting" integer NOT NULL,
	"cbsa_code" text,
	"factor_decimal" text NOT NULL,
	"load_source_ref" text NOT NULL,
	"loaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wage_index_factor_ccn_fy_uq" UNIQUE("ccn","fiscal_year_starting")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wage_index_factor_fy_idx" ON "wage_index_factor" ("fiscal_year_starting");--> statement-breakpoint

-- ============================================================================================
-- mac_submitter_credential — per-PE MAC portal credentials; client_secret_cipher is denylisted in audit.
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "mac_submitter_credential" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"mac_jurisdiction" "mac_jurisdiction" NOT NULL,
	"submitter_id" text NOT NULL,
	"trading_partner_id" text NOT NULL,
	"client_id" text NOT NULL,
	"client_secret_cipher" text NOT NULL,
	"client_secret_dek_version" integer NOT NULL,
	"baa_record_ref" text,
	"credential_expires_at" timestamp with time zone,
	"last_sandbox_test_at" timestamp with time zone,
	"set_by_membership_id" uuid NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mac_submitter_credential_pe_uq" UNIQUE("provider_entity_id"),
	CONSTRAINT "mac_submitter_credential_complete" CHECK (length("client_id") > 0 AND length("client_secret_cipher") > 0),
	CONSTRAINT "mac_submitter_credential_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict
);--> statement-breakpoint

-- ============================================================================================
-- eligibility_check — append-only; one row per HETS 270/271. parsed_payload denylisted; MBI never here.
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "eligibility_check" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"as_of_service_date" date NOT NULL,
	"outcome" "eligibility_outcome" NOT NULL,
	"parsed_payload" jsonb NOT NULL,
	"raw_response_file_uri" text,
	"worker_correlation_id" text,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"stale_at" timestamp with time zone NOT NULL,
	CONSTRAINT "eligibility_check_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "eligibility_check_patient_recent_idx" ON "eligibility_check" ("organization_id","patient_id","checked_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "eligibility_check_stale_idx" ON "eligibility_check" ("organization_id","stale_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "eligibility_check_recent_per_patient" ON "eligibility_check" ("organization_id","patient_id","checked_at" DESC) WHERE outcome IN ('active_part_a','inactive_part_a');
