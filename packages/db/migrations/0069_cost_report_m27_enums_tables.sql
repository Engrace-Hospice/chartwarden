-- M27 Cost Report §3.3 (D22) — enums + the 14 owned tables (hand-written SQL mirroring
-- packages/db/src/schema/cost-report/*.ts). NONE are partitioned (M27 is low row-count). RLS + grants
-- land in 0070; the cost_report_validation_rule platform-default SELECT branch in 0071 (isolated per the
-- feature_flag/role-template precedent); the M4 write-audit triggers in 0072.
--
-- ALL 15 M27 enums are created HERE (0069 runs first). Tenancy (§3.5 / ADR-0010, CANONICAL): EVERY
-- table carries organization_id (FK → organization, ON DELETE restrict) so the canonical app.org_id RLS
-- predicate applies directly — EXCEPT cost_report_validation_rule whose organization_id is NULLABLE
-- (platform-default rows; org-NULL read branch in 0071, NON_ORG_SCOPED-allowlisted). Intra-M27 parents
-- (cost_report, cost_report_validation, cost_report_validation_result, cost_report_snapshot) take SQL
-- FKs; every cross-module reference (provider_entity_id, *_membership_id, *_document_id, snapshot_id on
-- validation) is a plain uuid (app-validated, no FK), matching the mdm/quality cross-module-ref
-- convention. No PHI (D18) — aggregate financial/statistical only.
CREATE TYPE "public"."m27_cost_report_state" AS ENUM('draft', 'populating', 'validating', 'ready_for_review', 'approved_for_submit', 'submitted', 'accepted', 'rejected', 'reopened', 'closed');--> statement-breakpoint
CREATE TYPE "public"."m27_wage_source" AS ENUM('gusto', 'manual');--> statement-breakpoint
CREATE TYPE "public"."m27_worksheet_code" AS ENUM('S', 'S-1', 'S-2', 'S-3', 'S-4', 'A', 'A-1', 'A-6', 'A-7', 'A-8', 'B', 'B-1', 'C', 'D', 'E-1', 'F', 'G', 'G-1', 'G-2', 'G-3', 'H');--> statement-breakpoint
CREATE TYPE "public"."m27_snapshot_reason" AS ENUM('submit', 'reopen', 'mac_revision_request', 'admin_audit');--> statement-breakpoint
CREATE TYPE "public"."m27_validation_status" AS ENUM('in_progress', 'complete', 'failed_to_run');--> statement-breakpoint
CREATE TYPE "public"."m27_rule_category" AS ENUM('demographics_ownership', 'statistical_data', 'trial_balance', 'reclassifications', 'adjustments', 'cost_allocation', 'ancillary_apportionment', 'apportionment_programs', 'settlement', 'balance_sheet', 'cap', 'bad_debt', 'cross_worksheet', 'mac_specific', 'supporting_docs', 'filing_deadline');--> statement-breakpoint
CREATE TYPE "public"."m27_rule_severity" AS ENUM('block', 'warn', 'info');--> statement-breakpoint
CREATE TYPE "public"."m27_rule_status" AS ENUM('active', 'deprecated', 'draft_suggestion');--> statement-breakpoint
CREATE TYPE "public"."m27_validation_outcome" AS ENUM('pass', 'fail', 'warn', 'skip');--> statement-breakpoint
CREATE TYPE "public"."m27_bad_debt_kind" AS ENUM('deductible', 'coinsurance');--> statement-breakpoint
CREATE TYPE "public"."m27_import_source" AS ENUM('xero', 'manual_csv', 'gusto');--> statement-breakpoint
CREATE TYPE "public"."m27_import_status" AS ENUM('pending', 'complete', 'failed');--> statement-breakpoint
CREATE TYPE "public"."m27_mapping_source" AS ENUM('platform_default', 'tenant_override', 'tenant_extended');--> statement-breakpoint
CREATE TYPE "public"."m27_ecr_submission_status" AS ENUM('generating', 'generated', 'uploaded', 'accepted', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."m27_alert_tier" AS ENUM('none', 't4_months', 't4_5_months', 't4_75_months', 'past_deadline');--> statement-breakpoint
-- ============================================================================================
-- cost_report root (D1) — one per (provider_entity, fiscal_year_end).
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "cost_report" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"fiscal_year_start_date" date NOT NULL,
	"fiscal_year_end_date" date NOT NULL,
	"state" "m27_cost_report_state" DEFAULT 'draft' NOT NULL,
	"reopen_count" integer DEFAULT 0 NOT NULL,
	"latest_snapshot_id" uuid,
	"bad_debt_claimed" boolean DEFAULT false NOT NULL,
	"wage_source" "m27_wage_source" DEFAULT 'manual' NOT NULL,
	"deadline_extension_until_date" date,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "uniq_cost_report_provider_fye" UNIQUE("organization_id","provider_entity_id","fiscal_year_end_date"),
	CONSTRAINT "cost_report_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict
);
--> statement-breakpoint
-- ============================================================================================
-- worksheet / snapshot / validation cluster.
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "cost_report_worksheet" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"cost_report_id" uuid NOT NULL,
	"worksheet_code" "m27_worksheet_code" NOT NULL,
	"data" jsonb NOT NULL,
	"computed_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_worksheet_report_code" UNIQUE("cost_report_id","worksheet_code"),
	CONSTRAINT "cost_report_worksheet_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "cost_report_worksheet_cost_report_id_cost_report_id_fk" FOREIGN KEY ("cost_report_id") REFERENCES "public"."cost_report"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cost_report_snapshot" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"cost_report_id" uuid NOT NULL,
	"prior_snapshot_id" uuid,
	"content_hash_sha256" varchar(64) NOT NULL,
	"materialized_inputs" jsonb NOT NULL,
	"worksheet_snapshot" jsonb NOT NULL,
	"reason" "m27_snapshot_reason" NOT NULL,
	"created_by_membership_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cost_report_snapshot_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "cost_report_snapshot_cost_report_id_cost_report_id_fk" FOREIGN KEY ("cost_report_id") REFERENCES "public"."cost_report"("id"),
	CONSTRAINT "cost_report_snapshot_prior_snapshot_id_fk" FOREIGN KEY ("prior_snapshot_id") REFERENCES "public"."cost_report_snapshot"("id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cost_report_validation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"cost_report_id" uuid NOT NULL,
	"snapshot_id" uuid,
	"rule_set_version" integer NOT NULL,
	"status" "m27_validation_status" NOT NULL,
	"passed_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"overridden_count" integer DEFAULT 0 NOT NULL,
	"warning_count" integer DEFAULT 0 NOT NULL,
	"skipped_count" integer DEFAULT 0 NOT NULL,
	"run_started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"run_completed_at" timestamp with time zone,
	CONSTRAINT "cost_report_validation_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "cost_report_validation_cost_report_id_cost_report_id_fk" FOREIGN KEY ("cost_report_id") REFERENCES "public"."cost_report"("id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cost_report_validation_rule" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid,
	"rule_code" varchar(80) NOT NULL,
	"category" "m27_rule_category" NOT NULL,
	"description" varchar(500) NOT NULL,
	"rule_set_version" integer NOT NULL,
	"regulatory_required" boolean DEFAULT false NOT NULL,
	"severity" "m27_rule_severity" NOT NULL,
	"status" "m27_rule_status" DEFAULT 'active' NOT NULL,
	"mac_jurisdiction_scope" varchar(200) DEFAULT 'all' NOT NULL,
	"predicate_spec" jsonb NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deprecated_at" timestamp with time zone,
	CONSTRAINT "uniq_rule_org_code_version" UNIQUE("organization_id","rule_code","rule_set_version")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cost_report_validation_result" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"validation_id" uuid NOT NULL,
	"rule_id" uuid NOT NULL,
	"outcome" "m27_validation_outcome" NOT NULL,
	"details" jsonb NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cost_report_validation_result_org_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "cost_report_validation_result_validation_id_fk" FOREIGN KEY ("validation_id") REFERENCES "public"."cost_report_validation"("id") ON DELETE cascade,
	CONSTRAINT "cost_report_validation_result_rule_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."cost_report_validation_rule"("id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cost_report_validation_override" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"validation_result_id" uuid NOT NULL,
	"overridden_by_membership_id" uuid NOT NULL,
	"reason" varchar(1000) NOT NULL,
	"overridden_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_override_result" UNIQUE("validation_result_id"),
	CONSTRAINT "cost_report_validation_override_org_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "cost_report_validation_override_validation_result_id_fk" FOREIGN KEY ("validation_result_id") REFERENCES "public"."cost_report_validation_result"("id") ON DELETE cascade
);
--> statement-breakpoint
-- ============================================================================================
-- bad-debt / statistics / imports / mapping / submission / compliance-window.
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "bad_debt_record" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"cost_report_id" uuid NOT NULL,
	"period_label" varchar(20) NOT NULL,
	"debt_kind" "m27_bad_debt_kind" NOT NULL,
	"amount_cents" bigint NOT NULL,
	"collection_efforts_documented" boolean DEFAULT false NOT NULL,
	"supporting_document_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"added_by_membership_id" uuid NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by_membership_id" uuid,
	CONSTRAINT "bad_debt_record_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "bad_debt_record_cost_report_id_cost_report_id_fk" FOREIGN KEY ("cost_report_id") REFERENCES "public"."cost_report"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "statistic_data" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"cost_report_id" uuid NOT NULL,
	"monthly_breakdown" jsonb NOT NULL,
	"visit_counts_by_discipline" jsonb NOT NULL,
	"fte_calculations" jsonb NOT NULL,
	"bereavement_census" jsonb NOT NULL,
	"refreshed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"refreshed_by_membership_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "statistic_data_cost_report_id_unique" UNIQUE("cost_report_id"),
	CONSTRAINT "statistic_data_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "statistic_data_cost_report_id_cost_report_id_fk" FOREIGN KEY ("cost_report_id") REFERENCES "public"."cost_report"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "trial_balance_import" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"cost_report_id" uuid NOT NULL,
	"source" "m27_import_source" NOT NULL,
	"xero_tenant_id" varchar(100),
	"raw_payload_cipher" jsonb,
	"normalized_accounts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "m27_import_status" NOT NULL,
	"failure_reason" varchar(1000),
	"pulled_by_membership_id" uuid,
	"pulled_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trial_balance_import_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "trial_balance_import_cost_report_id_cost_report_id_fk" FOREIGN KEY ("cost_report_id") REFERENCES "public"."cost_report"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "wage_data_import" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"cost_report_id" uuid NOT NULL,
	"source" "m27_import_source" NOT NULL,
	"gusto_company_id" varchar(100),
	"raw_payload_cipher" jsonb,
	"normalized_wage_rows" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "m27_import_status" NOT NULL,
	"failure_reason" varchar(1000),
	"pulled_by_membership_id" uuid,
	"pulled_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wage_data_import_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "wage_data_import_cost_report_id_cost_report_id_fk" FOREIGN KEY ("cost_report_id") REFERENCES "public"."cost_report"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cost_center_mapping" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"fiscal_year_int" integer NOT NULL,
	"xero_account_code" varchar(50) NOT NULL,
	"xero_account_name" varchar(200) NOT NULL,
	"cms_cost_center_code" varchar(50) NOT NULL,
	"mapping_source" "m27_mapping_source" NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_mapping_org_provider_fy_account" UNIQUE("organization_id","provider_entity_id","fiscal_year_int","xero_account_code"),
	CONSTRAINT "cost_center_mapping_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ecr_submission" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"cost_report_id" uuid NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"ecr_file_document_id" uuid,
	"pi_file_document_id" uuid,
	"supporting_documents_document_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "m27_ecr_submission_status" DEFAULT 'generating' NOT NULL,
	"mcref_acknowledgment_number" varchar(100),
	"mcref_rejection_code" varchar(100),
	"mcref_rejection_detail" varchar(2000),
	"uploaded_by_membership_id" uuid,
	"uploaded_at" timestamp with time zone,
	"acknowledged_at" timestamp with time zone,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_ecr_ack_xor_reject" CHECK (NOT ("mcref_acknowledgment_number" IS NOT NULL AND "mcref_rejection_code" IS NOT NULL)),
	CONSTRAINT "ecr_submission_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "ecr_submission_cost_report_id_cost_report_id_fk" FOREIGN KEY ("cost_report_id") REFERENCES "public"."cost_report"("id"),
	CONSTRAINT "ecr_submission_snapshot_id_cost_report_snapshot_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."cost_report_snapshot"("id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cost_report_compliance_window" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"cost_report_id" uuid NOT NULL,
	"deadline_date" date NOT NULL,
	"current_effective_deadline_date" date NOT NULL,
	"last_alert_tier_emitted_at" timestamp with time zone,
	"last_alert_tier" "m27_alert_tier" DEFAULT 'none' NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "cost_report_compliance_window_cost_report_id_unique" UNIQUE("cost_report_id"),
	CONSTRAINT "cost_report_compliance_window_org_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "cost_report_compliance_window_cost_report_id_cost_report_id_fk" FOREIGN KEY ("cost_report_id") REFERENCES "public"."cost_report"("id") ON DELETE cascade
);
--> statement-breakpoint
-- ============================================================================================
-- Indexes (§3.3 + §3.4). FKs auto-index in PG only for the referenced side; add the read-path indexes.
-- ============================================================================================
CREATE INDEX IF NOT EXISTS "idx_cost_report_org_state" ON "cost_report" ("organization_id","state");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_cost_report_provider_fye_date" ON "cost_report" ("provider_entity_id","fiscal_year_end_date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_worksheet_org_report" ON "cost_report_worksheet" ("organization_id","cost_report_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_worksheet_derived" ON "cost_report_worksheet" ("cost_report_id") WHERE worksheet_code IN ('B','C','D','E-1');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_snapshot_org_report" ON "cost_report_snapshot" ("organization_id","cost_report_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_snapshot_content_hash" ON "cost_report_snapshot" ("content_hash_sha256");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_snapshot_report_created_desc" ON "cost_report_snapshot" ("cost_report_id","created_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_validation_org_report_run" ON "cost_report_validation" ("organization_id","cost_report_id","run_started_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_rule_status" ON "cost_report_validation_rule" ("status","severity");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_val_result_validation_outcome" ON "cost_report_validation_result" ("validation_id","outcome");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_val_result_failures" ON "cost_report_validation_result" ("validation_id","recorded_at") WHERE outcome IN ('fail','warn');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_override_org" ON "cost_report_validation_override" ("organization_id","overridden_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_bad_debt_org_report_period" ON "bad_debt_record" ("organization_id","cost_report_id","period_label");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_bad_debt_live" ON "bad_debt_record" ("cost_report_id","period_label") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_stats_org_report" ON "statistic_data" ("organization_id","cost_report_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_tb_import_org_report_pulled" ON "trial_balance_import" ("organization_id","cost_report_id","pulled_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_tb_import_canonical" ON "trial_balance_import" ("cost_report_id","pulled_at" DESC) WHERE status = 'complete';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_wage_import_org_report_pulled" ON "wage_data_import" ("organization_id","cost_report_id","pulled_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_wage_import_canonical" ON "wage_data_import" ("cost_report_id","pulled_at" DESC) WHERE status = 'complete';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_mapping_org_provider_fy" ON "cost_center_mapping" ("organization_id","provider_entity_id","fiscal_year_int");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ecr_org_report_status" ON "ecr_submission" ("organization_id","cost_report_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_window_org_deadline" ON "cost_report_compliance_window" ("organization_id","current_effective_deadline_date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_window_last_tier" ON "cost_report_compliance_window" ("last_alert_tier","current_effective_deadline_date");
