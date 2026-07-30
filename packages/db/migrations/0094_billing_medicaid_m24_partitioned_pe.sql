-- M24 Billing — Medicaid §3.3/§3.2 — the two PE-partitioned tables (medicaid_claim root + medicaid_claim_line).
-- Both PARTITION BY LIST(provider_entity_id) — the per-CCN tenancy spine (§3.3). In their OWN file because
-- check-ddl-legality rule 1 derives ONE partition column per file from the first `PARTITION BY` and then
-- requires every UNIQUE/PK in the file to include it: provider_entity_id is in every PK + unique index here.
-- Each carries a composite PK (id, provider_entity_id) including the partition key (ADR-0022) + a DEFAULT
-- partition so inserts work immediately (no PEs at migrate time); the M1 partition-manager adds per-PE leaves
-- and the §3.2-Phase-F inner quarterly RANGE(created_at / service_date) rotation later (deferred — the LIST
-- key is the tenancy-isolation level that keeps the unique indexes legal; the M23 0074 precedent exactly).
--
-- CROSS-MODULE FK POLICY: organization_id / provider_entity_id / location_id (M1 core) get real FKs.
-- medicaid_claim_id (partitioned parent), patient_id / patient_payer_id (M5), admission_id / loc_period_id
-- (M6), medicare_claim_id (M23), state_plan_code_id / mco_id / state_rate_schedule_id_snapshot (M40),
-- rb_arrangement_id / rb_day_id / eligibility_check_id / validation_run_id_latest / replaces/replaced_by
-- are LOGICAL uuid. Money is INTEGER cents.

-- ============================================================================================
-- medicaid_claim — claim root
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "medicaid_claim" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"location_id" uuid,
	"patient_id" uuid NOT NULL,
	"patient_payer_id" uuid NOT NULL,
	"admission_id" uuid NOT NULL,
	"service_state" varchar(2) NOT NULL,
	"kind" "m24_claim_kind" NOT NULL,
	"tob" varchar(4) NOT NULL,
	"service_from" timestamp with time zone NOT NULL,
	"service_to" timestamp with time zone NOT NULL,
	"state_plan_code_id" uuid NOT NULL,
	"state_plan_code_snapshot" varchar(32) NOT NULL,
	"mco_id" uuid,
	"mco_snapshot" jsonb,
	"medicare_claim_id" uuid,
	"medicare_secondary_context_snapshot" jsonb,
	"rb_arrangement_id" uuid,
	"rb_day_count_snapshot" integer,
	"replaces_claim_id" uuid,
	"replaced_by_claim_id" uuid,
	"medicaid_claim_control_number" varchar(32) NOT NULL,
	"state" "m24_claim_state" DEFAULT 'DRAFT' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"eligibility_check_id" uuid,
	"eligibility_outcome_snapshot" varchar(32),
	"eligibility_checked_at_snapshot" timestamp with time zone,
	"validation_run_id_latest" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_membership_id" uuid NOT NULL,
	"updated_by_membership_id" uuid NOT NULL,
	CONSTRAINT "medicaid_claim_pk" PRIMARY KEY ("id","provider_entity_id"),
	CONSTRAINT "medicaid_claim_org_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "medicaid_claim_pe_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict,
	CONSTRAINT "medicaid_claim_location_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict,
	CONSTRAINT "medicaid_claim_replacement_requires_predecessor" CHECK ((tob IN ('817','818') AND replaces_claim_id IS NOT NULL) OR (tob NOT IN ('817','818') AND replaces_claim_id IS NULL)),
	CONSTRAINT "medicare_secondary_requires_medicare_fk" CHECK ((medicare_secondary_context_snapshot IS NULL AND medicare_claim_id IS NULL) OR (medicare_secondary_context_snapshot IS NOT NULL AND medicare_claim_id IS NOT NULL)),
	CONSTRAINT "medicaid_claim_service_range_valid" CHECK (service_from <= service_to)
) PARTITION BY LIST ("provider_entity_id");--> statement-breakpoint
CREATE OR REPLACE FUNCTION create_medicaid_claim_partition(p_provider_entity_id uuid) RETURNS void AS $$
DECLARE partition_name text;
BEGIN
  partition_name := 'medicaid_claim_pe_' || replace(p_provider_entity_id::text, '-', '');
  EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF medicaid_claim FOR VALUES IN (%L)', partition_name, p_provider_entity_id);
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DO $$ BEGIN
  EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF medicaid_claim DEFAULT', 'medicaid_claim_default');
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "medicaid_claim_control_per_pe_state" ON "medicaid_claim" ("provider_entity_id","service_state","medicaid_claim_control_number");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "medicaid_claim_by_org_state" ON "medicaid_claim" ("organization_id","state");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "medicaid_claim_by_replaces" ON "medicaid_claim" ("replaces_claim_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "medicaid_claim_by_medicare_primary" ON "medicaid_claim" ("organization_id","medicare_claim_id");--> statement-breakpoint

-- ============================================================================================
-- medicaid_claim_line — service-date lines
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "medicaid_claim_line" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"location_id" uuid,
	"medicaid_claim_id" uuid NOT NULL,
	"line_number" integer NOT NULL,
	"service_date" timestamp with time zone NOT NULL,
	"revenue_code" varchar(4) NOT NULL,
	"q_code" varchar(8) NOT NULL,
	"hcpcs_modifier_1" varchar(2),
	"hcpcs_modifier_2" varchar(2),
	"hcpcs_modifier_3" varchar(2),
	"hcpcs_modifier_4" varchar(2),
	"level_of_care" "m24_claim_line_loc" NOT NULL,
	"loc_period_id" uuid NOT NULL,
	"units" integer NOT NULL,
	"rate_at_assembly_cents" integer NOT NULL,
	"state_rate_schedule_id_snapshot" uuid NOT NULL,
	"charges_cents" integer NOT NULL,
	"cob_paid_cents" integer,
	"patient_responsibility_cents" integer,
	"is_rb" boolean DEFAULT false NOT NULL,
	"rb_day_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "medicaid_claim_line_pk" PRIMARY KEY ("id","provider_entity_id"),
	CONSTRAINT "medicaid_claim_line_org_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "medicaid_claim_line_pe_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict,
	CONSTRAINT "medicaid_claim_line_location_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict,
	CONSTRAINT "medicaid_claim_line_rb_requires_rb_day" CHECK ((is_rb = false) OR (is_rb = true AND rb_day_id IS NOT NULL)),
	CONSTRAINT "medicaid_claim_line_units_positive" CHECK (units > 0),
	CONSTRAINT "medicaid_claim_line_rate_positive" CHECK (rate_at_assembly_cents > 0)
) PARTITION BY LIST ("provider_entity_id");--> statement-breakpoint
CREATE OR REPLACE FUNCTION create_medicaid_claim_line_partition(p_provider_entity_id uuid) RETURNS void AS $$
DECLARE partition_name text;
BEGIN
  partition_name := 'medicaid_claim_line_pe_' || replace(p_provider_entity_id::text, '-', '');
  EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF medicaid_claim_line FOR VALUES IN (%L)', partition_name, p_provider_entity_id);
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DO $$ BEGIN
  EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF medicaid_claim_line DEFAULT', 'medicaid_claim_line_default');
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "medicaid_claim_line_unique_per_claim" ON "medicaid_claim_line" ("provider_entity_id","medicaid_claim_id","line_number");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "medicaid_claim_line_by_org_service_date" ON "medicaid_claim_line" ("organization_id","service_date");--> statement-breakpoint
