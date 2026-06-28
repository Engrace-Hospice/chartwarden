-- M25 Remittance & Denials §3.2 Phase A + Phase B — the 20 `m25_*` ENUM types + the seven
-- NON-partitioned owned tables (remittance_advice envelope head + the denial-worklist / appeal /
-- PR-ledger cluster). The four PARTITIONED line/service-line/adjustment/remark tables land in 0082;
-- RLS/grants in 0083; M4 write-audit + appeal closed-row immutability in 0084.
--
-- CONVENTIONS (mirror M23 0074-0075 / M27 0069 / M30): enum types are `m25_`-prefixed (anti-collision,
-- check-ddl-legality rule 3 — one CREATE TYPE pairs 1:1 with the pgEnum in src/schema/remittance/enums.ts).
-- CROSS-MODULE FK POLICY (architecture WINS): only organization_id → organization and intra-M25
-- non-partitioned parents (denial_case, appeal_case) are real FKs; provider_entity_id (M40/M2),
-- payer_id (M40), claim_id (M23), patient_id (M5), source_evv_aggregator_submission_id (M18),
-- appeal_packet_document_id (M22), the partitioned-line ids, and *_membership_id (core) are LOGICAL uuid.
-- denial_taxonomy_overlay is strictly org-scoped (M25-F09): organization_id NOT NULL, NO platform NULL row.

-- ============================================================================================
-- Phase A — enums (20)
-- ============================================================================================
CREATE TYPE "public"."m25_payer_kind" AS ENUM('medicare', 'medicaid', 'commercial');--> statement-breakpoint
CREATE TYPE "public"."m25_payment_method_kind" AS ENUM('check', 'eft', 'non_payment_remit');--> statement-breakpoint
CREATE TYPE "public"."m25_parse_status" AS ENUM('queued', 'parsing', 'parsed', 'posted', 'partial_posted', 'failed');--> statement-breakpoint
CREATE TYPE "public"."m25_match_state" AS ENUM('unmatched', 'auto_matched', 'manual_matched', 'reversed', 'posted');--> statement-breakpoint
CREATE TYPE "public"."m25_match_strategy" AS ENUM('payer_icn', 'patient_control', 'heuristic', 'manual');--> statement-breakpoint
CREATE TYPE "public"."m25_cas_group_code" AS ENUM('CO', 'CR', 'OA', 'PI', 'PR');--> statement-breakpoint
CREATE TYPE "public"."m25_taxonomy_status" AS ENUM('mapped', 'unmapped');--> statement-breakpoint
CREATE TYPE "public"."m25_post_action" AS ENUM('auto_posted', 'ledger_recorded', 'flagged_review', 'denial_seeded');--> statement-breakpoint
CREATE TYPE "public"."m25_remark_kind" AS ENUM('LQ', 'MIA', 'MOA');--> statement-breakpoint
CREATE TYPE "public"."m25_denial_category" AS ENUM('denial', 'reduction', 'informational', 'recoupment', 'unmapped');--> statement-breakpoint
CREATE TYPE "public"."m25_denial_source" AS ENUM('remittance_adjustment', 'claim_rejection_277ca', 'evv_aggregator_rejection');--> statement-breakpoint
CREATE TYPE "public"."m25_denial_state" AS ENUM('open', 'in_progress', 'escalated', 'appealed', 'resolved', 'closed');--> statement-breakpoint
CREATE TYPE "public"."m25_denial_closure_outcome" AS ENUM('resolved_no_appeal', 'resolved_via_appeal', 'written_off', 'recouped', 'reassigned_to_other_payer', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."m25_appeal_tier" AS ENUM('redetermination', 'reconsideration', 'alj', 'council', 'federal_court');--> statement-breakpoint
CREATE TYPE "public"."m25_appeal_state" AS ENUM('draft', 'submitted', 'under_review', 'decided', 'withdrawn', 'closed');--> statement-breakpoint
CREATE TYPE "public"."m25_appeal_decision_outcome" AS ENUM('favorable', 'partial', 'unfavorable');--> statement-breakpoint
CREATE TYPE "public"."m25_appeal_event_kind" AS ENUM('created', 'attached_document', 'submitted', 'received_ack', 'under_review', 'decided', 'withdrawn', 'escalated_to_next_tier', 'closed');--> statement-breakpoint
CREATE TYPE "public"."m25_taxonomy_owner_role" AS ENUM('billing_specialist', 'billing_manager', 'clinical_records', 'compliance_officer', 'md_or_np');--> statement-breakpoint
CREATE TYPE "public"."m25_taxonomy_severity" AS ENUM('info', 'warn', 'critical');--> statement-breakpoint
CREATE TYPE "public"."m25_pr_ledger_status" AS ENUM('recorded', 'invoiced', 'paid', 'written_off');--> statement-breakpoint

-- ============================================================================================
-- Phase B — non-partitioned tables
-- ============================================================================================

-- remittance_advice — one row per X12 5010 835 transaction. ISA+ST uniqueness per provider entity.
CREATE TABLE IF NOT EXISTS "remittance_advice" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"payer_id" uuid NOT NULL,
	"payer_kind" "m25_payer_kind" NOT NULL,
	"interchange_control_number" varchar(9) NOT NULL,
	"transaction_set_control_number" varchar(9) NOT NULL,
	"check_or_eft_trace_number" varchar(50),
	"payment_method" "m25_payment_method_kind" NOT NULL,
	"total_payment_amount" numeric(12, 2) NOT NULL,
	"production_date" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"minio_object_key" varchar(500) NOT NULL,
	"file_sha256" varchar(64) NOT NULL,
	"parse_status" "m25_parse_status" DEFAULT 'queued' NOT NULL,
	"parse_summary" jsonb,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "remittance_advice_pk" PRIMARY KEY ("id"),
	CONSTRAINT "remittance_advice_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ux_remittance_envelope_dedupe" ON "remittance_advice" ("interchange_control_number","transaction_set_control_number","provider_entity_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_remittance_advice_pe_received" ON "remittance_advice" ("provider_entity_id","received_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_remittance_advice_payer" ON "remittance_advice" ("payer_id","received_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_remittance_advice_parse_status" ON "remittance_advice" ("parse_status") WHERE parse_status <> 'posted';--> statement-breakpoint

-- denial_case — the worklist aggregate. xor-or subject (claim_id | remittance_line_id | evv submission).
CREATE TABLE IF NOT EXISTS "denial_case" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"claim_id" uuid,
	"remittance_line_id" uuid,
	"remittance_service_line_id" uuid,
	"remittance_adjustment_id" uuid,
	"source_evv_aggregator_submission_id" uuid,
	"carc_code" varchar(8) NOT NULL,
	"rarc_code" varchar(8),
	"category" "m25_denial_category" NOT NULL,
	"source" "m25_denial_source" NOT NULL,
	"state" "m25_denial_state" DEFAULT 'open' NOT NULL,
	"closure_outcome" "m25_denial_closure_outcome",
	"assignee_membership_id" uuid,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"first_actioned_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"dollar_value" numeric(12, 2) NOT NULL,
	"aging_bucket_days" smallint DEFAULT 0 NOT NULL,
	"override_payload" jsonb,
	"taxonomy_status" "m25_taxonomy_status" NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "denial_case_pk" PRIMARY KEY ("id"),
	CONSTRAINT "denial_case_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "denial_case_dollar_nonneg" CHECK ("dollar_value" >= 0),
	CONSTRAINT "denial_case_has_subject" CHECK (("claim_id" IS NOT NULL) OR ("remittance_line_id" IS NOT NULL) OR ("source_evv_aggregator_submission_id" IS NOT NULL))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_denial_assignee" ON "denial_case" ("assignee_membership_id","state");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_denial_claim" ON "denial_case" ("claim_id") WHERE claim_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_denial_carc" ON "denial_case" ("carc_code");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_denial_aging" ON "denial_case" ("aging_bucket_days","state") WHERE state IN ('open','in_progress','escalated');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_denial_pe" ON "denial_case" ("provider_entity_id","state");--> statement-breakpoint

-- denial_case_assignment — assignee history (organization_id added per the three-column posture).
CREATE TABLE IF NOT EXISTS "denial_case_assignment" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"denial_case_id" uuid NOT NULL,
	"assigned_to_membership_id" uuid NOT NULL,
	"assigned_by_membership_id" uuid NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"unassigned_at" timestamp with time zone,
	"reason" text,
	CONSTRAINT "denial_case_assignment_pk" PRIMARY KEY ("id"),
	CONSTRAINT "denial_case_assignment_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "denial_case_assignment_denial_case_id_fk" FOREIGN KEY ("denial_case_id") REFERENCES "public"."denial_case"("id") ON DELETE restrict
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_assignment_case" ON "denial_case_assignment" ("denial_case_id","assigned_at");--> statement-breakpoint

-- appeal_case — five-tier Medicare hierarchy. decision_outcome required once decided.
CREATE TABLE IF NOT EXISTS "appeal_case" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"denial_case_id" uuid NOT NULL,
	"claim_id" uuid NOT NULL,
	"prior_tier_appeal_case_id" uuid,
	"tier" "m25_appeal_tier" NOT NULL,
	"state" "m25_appeal_state" DEFAULT 'draft' NOT NULL,
	"decision_outcome" "m25_appeal_decision_outcome",
	"tier_deadline_at" timestamp with time zone NOT NULL,
	"submitted_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"appeal_packet_document_id" uuid,
	"appeal_narrative" jsonb,
	"mac_reference_numbers" jsonb,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "appeal_case_pk" PRIMARY KEY ("id"),
	CONSTRAINT "appeal_case_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "appeal_case_denial_case_id_fk" FOREIGN KEY ("denial_case_id") REFERENCES "public"."denial_case"("id") ON DELETE restrict,
	CONSTRAINT "appeal_case_decided_has_outcome" CHECK ("state" <> 'decided' OR "decision_outcome" IS NOT NULL)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_appeal_denial" ON "appeal_case" ("denial_case_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_appeal_claim" ON "appeal_case" ("claim_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_appeal_deadline" ON "appeal_case" ("tier_deadline_at","state") WHERE state IN ('draft','submitted','under_review');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_appeal_tier" ON "appeal_case" ("tier","state");--> statement-breakpoint

-- appeal_case_event — lifecycle history (organization_id added per the three-column posture).
CREATE TABLE IF NOT EXISTS "appeal_case_event" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"appeal_case_id" uuid NOT NULL,
	"event_kind" "m25_appeal_event_kind" NOT NULL,
	"event_payload" jsonb,
	"actor_membership_id" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "appeal_case_event_pk" PRIMARY KEY ("id"),
	CONSTRAINT "appeal_case_event_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "appeal_case_event_appeal_case_id_fk" FOREIGN KEY ("appeal_case_id") REFERENCES "public"."appeal_case"("id") ON DELETE restrict
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_appeal_event_case" ON "appeal_case_event" ("appeal_case_id","occurred_at");--> statement-breakpoint

-- denial_taxonomy_overlay — per-tenant overlay (strictly org-scoped, M25-F09). category lives in M38.
CREATE TABLE IF NOT EXISTS "denial_taxonomy_overlay" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"carc_code" varchar(8) NOT NULL,
	"rarc_code" varchar(8),
	"plain_language_override" text,
	"suggested_action" text NOT NULL,
	"owner_role" "m25_taxonomy_owner_role" NOT NULL,
	"severity" "m25_taxonomy_severity" NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "denial_taxonomy_overlay_pk" PRIMARY KEY ("id"),
	CONSTRAINT "denial_taxonomy_overlay_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "ux_taxonomy_overlay_org_carc_rarc" UNIQUE ("organization_id","carc_code","rarc_code")
);--> statement-breakpoint

-- patient_responsibility_ledger — read-only PR ledger (Phase 1). pr_amount > 0.
CREATE TABLE IF NOT EXISTS "patient_responsibility_ledger" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"remittance_line_id" uuid NOT NULL,
	"remittance_adjustment_id" uuid NOT NULL,
	"pr_amount" numeric(12, 2) NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" "m25_pr_ledger_status" DEFAULT 'recorded' NOT NULL,
	"invoice_ref" varchar(80),
	CONSTRAINT "patient_responsibility_ledger_pk" PRIMARY KEY ("id"),
	CONSTRAINT "patient_responsibility_ledger_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "pr_ledger_amount_positive" CHECK ("pr_amount" > 0)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_pr_ledger_patient" ON "patient_responsibility_ledger" ("patient_id","recorded_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_pr_ledger_status" ON "patient_responsibility_ledger" ("status");
