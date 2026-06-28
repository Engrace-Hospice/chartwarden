-- M23 Billing — Medicare §3.2 (Phase A enums) + §3.3 (the `claim` root table). Hand-written SQL
-- mirroring packages/db/src/schema/billing/*.ts (M27 cost-report precedent: 0069 enums+tables).
--
-- ALL 18 M23 enums are created HERE (0074 runs first, before any table that uses them). Enum names are
-- UN-prefixed exactly per §3.3 (claim_state, claim_tob, …) so the Drizzle `pgEnum('claim_state', …)` in
-- the schema package pairs 1:1 with these `CREATE TYPE`s (check-ddl-legality treats one CREATE TYPE +
-- one pgEnum of the same name as the normal Drizzle pattern, NOT a duplicate). No collisions with prior
-- modules (verified) — M27 used m27_* prefixes, M23 uses the spec's bare names.
--
-- PARTITIONING DECISION (deviates from §3.2 Phase B; documented per "architecture wins"):
--   • §3.2 asks for two-level `LIST(provider_entity_id) → RANGE(created_at) quarterly` on `claim`.
--     Genuine two-level sub-partitioning is INCOMPATIBLE with the §3.3 DDL in three ways that
--     PostgreSQL enforces (not just our checker): (a) a UNIQUE/PK on a partitioned table must include
--     EVERY partition column from EVERY level, so `claim_control_number_uq(provider_entity_id, …)` and
--     the partial `claim_active_by_range_uq` would each need `created_at` too — which breaks their
--     semantics (a control number is unique per-PE forever, not per-quarter); (b) a PARTIAL UNIQUE index
--     is not creatable on a partitioned PARENT at all; (c) the composite PK forces every intra-M23 FK
--     TO `claim` to reference the full composite, which none of the §3.3 child FKs do.
--   • RESOLUTION (Phase-1 foundation): partition `claim` SINGLE-LEVEL by `LIST(provider_entity_id)` —
--     this is the level that makes `claim_control_number_uq(provider_entity_id, …)` LEGAL and correct
--     (each PE = one partition → per-leaf uniqueness == global per-(PE, ccn) uniqueness). The inner
--     `RANGE(created_at)` quarterly rotation is DEFERRED to the M1 partition-manager (§3.2 Phase F):
--     a pure storage/retention optimization that does not change the logical schema. A DEFAULT
--     partition catches every PE so inserts work immediately (no provider entities exist at migrate
--     time). `create_claim_partition(uuid)` is the per-PE leaf hook for onboarding / the partition cron.
--   • CONSEQUENCE: `claim`'s composite PK is (id, provider_entity_id); every intra-M23 reference to
--     `claim.id` (claim_line, claim_submission, claim_acknowledgment, hipps_calculation,
--     sia_calculation, validation_run, claim_state_history) is therefore a LOGICAL FK (plain uuid, no
--     SQL FK) — the same posture M30 incident_report (composite PK) + the M27/MDM cross-ref convention
--     already use. The ONLY real cross-module FK is to `organization` (the tenancy root, M27 precedent);
--     provider_entity_id / *_membership_id / all M5/M6/M8 ids are plain uuid (app-validated).
--
-- Because check-ddl-legality rule 1 derives ONE partition column per file from the first `PARTITION BY`,
-- `claim` (LIST provider_entity_id) lives ALONE here; the 13 non-partitioned tables land in 0075 and the
-- three LIST(organization_id) history tables in 0076 (the M30 one-partitioned-table-shape-per-file rule).
-- RLS + grants in 0077; the wage_index_factor platform policy (isolated) in 0078; M4 write-audit +
-- append-only triggers in 0079; platform seed in 0080. No PHI column is value-captured in audit; MBI is
-- never persisted (§3.6, §8.7, D13).

-- ============================================================================================
-- Phase A — enums (§3.3 billing/enums.ts). notr_state intentionally duplicates noe_state's shape.
-- ============================================================================================
CREATE TYPE "public"."claim_state" AS ENUM('DRAFT', 'VALIDATING', 'READY', 'SUBMITTED', 'ACK_PENDING', 'ACK_ACCEPTED', 'ACK_REJECTED', 'ACK_PARTIAL', 'PAID', 'DENIED', 'REPLACED', 'VOIDED');--> statement-breakpoint
CREATE TYPE "public"."claim_tob" AS ENUM('811', '812', '813', '814', '817', '818');--> statement-breakpoint
CREATE TYPE "public"."claim_line_revenue_code" AS ENUM('0651', '0652', '0655', '0656', '0657', '0659', '0294', '0942');--> statement-breakpoint
CREATE TYPE "public"."claim_line_q_code" AS ENUM('Q5001', 'Q5002', 'Q5003', 'Q5004', 'Q5005', 'Q5006', 'Q5007', 'Q5008', 'Q5009', 'Q5010');--> statement-breakpoint
CREATE TYPE "public"."claim_line_level_of_care" AS ENUM('RHC', 'CHC', 'IRC', 'GIP');--> statement-breakpoint
CREATE TYPE "public"."noe_state" AS ENUM('DRAFT', 'READY', 'SUBMITTED', 'ACK_PENDING', 'ACK_ACCEPTED', 'ACK_REJECTED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."notr_state" AS ENUM('DRAFT', 'READY', 'SUBMITTED', 'ACK_PENDING', 'ACK_ACCEPTED', 'ACK_REJECTED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."notr_trigger_kind" AS ENUM('revocation', 'transfer_out', 'discharge');--> statement-breakpoint
CREATE TYPE "public"."validation_severity" AS ENUM('error', 'warn', 'info');--> statement-breakpoint
CREATE TYPE "public"."validation_result_outcome" AS ENUM('pass', 'fail', 'warn', 'info');--> statement-breakpoint
CREATE TYPE "public"."validation_run_trigger" AS ENUM('initial_assembly', 'pre_submission', 're_validation_after_correction', 're_validation_after_override', 'manual_re_run');--> statement-breakpoint
CREATE TYPE "public"."validation_run_outcome" AS ENUM('all_pass', 'failures_present', 'overrides_required', 'ready_for_submission');--> statement-breakpoint
CREATE TYPE "public"."override_role_required" AS ENUM('billing_manager', 'compliance_officer', 'medical_director', 'org_admin');--> statement-breakpoint
CREATE TYPE "public"."mac_jurisdiction" AS ENUM('ngs_j6', 'ngs_jk', 'cgs_j15', 'palmetto_jj', 'palmetto_jm', 'noridian_jf', 'noridian_je');--> statement-breakpoint
CREATE TYPE "public"."claim_submission_kind" AS ENUM('claim_837i', 'noe', 'notr');--> statement-breakpoint
CREATE TYPE "public"."claim_submission_outcome" AS ENUM('queued', 'generated', 'submitted', 'failed_worker', 'failed_portal');--> statement-breakpoint
CREATE TYPE "public"."claim_acknowledgment_kind" AS ENUM('ack_999', 'ack_277ca', 'ack_835');--> statement-breakpoint
CREATE TYPE "public"."eligibility_outcome" AS ENUM('active_part_a', 'inactive_part_a', 'mbi_invalid', 'unknown_response', 'hets_error');--> statement-breakpoint

-- ============================================================================================
-- Phase B — `claim` (D4 deterministic control number, D14 replacement chain). PARTITION BY
-- LIST(provider_entity_id). Composite PK (id, provider_entity_id) includes the partition key
-- (ADR-0022 D1.1). organization_id FK → organization (ON DELETE restrict); every other reference is a
-- plain uuid logical FK. Postgres requires PARTITION BY at CREATE time.
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "claim" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"admission_id" uuid NOT NULL,
	"election_period_id_from" uuid NOT NULL,
	"election_period_id_to" uuid NOT NULL,
	"patient_payer_id" uuid NOT NULL,
	"tob" "claim_tob" NOT NULL,
	"service_from" date NOT NULL,
	"service_to" date NOT NULL,
	"state" "claim_state" DEFAULT 'DRAFT' NOT NULL,
	"claim_control_number" text NOT NULL,
	"payer_claim_control_number" text,
	"mac_jurisdiction" "mac_jurisdiction" NOT NULL,
	"total_charge_cents" bigint DEFAULT 0 NOT NULL,
	"total_expected_payment_cents" bigint DEFAULT 0 NOT NULL,
	"sequestration_applied_pct" text NOT NULL,
	"sequestration_policy_id" uuid NOT NULL,
	"replaces_claim_id" uuid,
	"replaced_by_claim_id" uuid,
	"replacement_reason" text,
	"latest_validation_run_id" uuid,
	"latest_submission_id" uuid,
	"acknowledgment_document_id" uuid,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_membership_id" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "claim_pk" PRIMARY KEY ("id","provider_entity_id"),
	CONSTRAINT "claim_service_dates_valid" CHECK ("service_to" >= "service_from"),
	CONSTRAINT "claim_replacement_requires_predecessor" CHECK (("tob" IN ('817','818')) = ("replaces_claim_id" IS NOT NULL)),
	CONSTRAINT "claim_replacement_reason_floor" CHECK ("replaces_claim_id" IS NULL OR length("replacement_reason") >= 40),
	CONSTRAINT "claim_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict
) PARTITION BY LIST ("provider_entity_id");--> statement-breakpoint
-- Per-LEAF partial-UNIQUE backstop: at most one non-superseded interim claim per (PE, patient, exact
-- from-through). It is a PARTIAL unique (not creatable on a partitioned parent) and omits no partition
-- column at the leaf level, so it is added to each leaf. Per-leaf == globally correct: each PE is exactly
-- one LIST leaf, so uniqueness within the leaf is uniqueness within the PE (the constraint's scope).
CREATE OR REPLACE FUNCTION add_claim_unique_indexes(partition_name text) RETURNS void AS $$
BEGIN
  EXECUTE format(
    'CREATE UNIQUE INDEX IF NOT EXISTS %I ON %I (provider_entity_id, patient_id, service_from, service_to) WHERE tob IN (''811'',''812'',''813'',''814'') AND state NOT IN (''VOIDED'',''REPLACED'',''ACK_REJECTED'')',
    partition_name || '_active_by_range_uidx', partition_name
  );
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
-- Per-PE leaf hook for onboarding / the M1 partition-manager (the §3.2 Phase F registration target).
CREATE OR REPLACE FUNCTION create_claim_partition(p_provider_entity_id uuid) RETURNS void AS $$
DECLARE partition_name text;
BEGIN
  partition_name := 'claim_pe_' || replace(p_provider_entity_id::text, '-', '');
  EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF claim FOR VALUES IN (%L)', partition_name, p_provider_entity_id);
  PERFORM add_claim_unique_indexes(partition_name);
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
-- DEFAULT partition so inserts work before any per-PE leaf exists (no provider entities at migrate time).
DO $$ BEGIN
  EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF claim DEFAULT', 'claim_default');
  PERFORM add_claim_unique_indexes('claim_default');
END $$;--> statement-breakpoint
-- Phase C — claim indexes (§3.3 inline + §3.4). The full UNIQUE on (provider_entity_id, …) INCLUDES the
-- partition key, so it lives on the partitioned PARENT (legal, globally enforced).
CREATE UNIQUE INDEX IF NOT EXISTS "claim_control_number_uq" ON "claim" ("provider_entity_id","claim_control_number");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "claim_org_pe_idx" ON "claim" ("organization_id","provider_entity_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "claim_patient_idx" ON "claim" ("organization_id","patient_id","service_from");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "claim_state_idx" ON "claim" ("organization_id","state","service_from");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "claim_replaces_idx" ON "claim" ("replaces_claim_id") WHERE replaces_claim_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "claim_org_pe_state_partial" ON "claim" ("organization_id","provider_entity_id","state") WHERE state IN ('VALIDATING','READY','SUBMITTED','ACK_PENDING');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "claim_patient_state_partial" ON "claim" ("organization_id","patient_id","state") WHERE state NOT IN ('PAID','VOIDED','REPLACED','DENIED');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "claim_service_from_brin" ON "claim" USING brin ("service_from");
