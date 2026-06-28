-- M23 Billing — Medicare §3.3 — the three append-only history / validation tables, all PARTITION BY
-- LIST(organization_id). In their OWN file (separate from 0074 claim / 0075 non-partitioned) because
-- check-ddl-legality rule 1 derives ONE partition column per file from the first `PARTITION BY` and then
-- requires every UNIQUE/PK in the file to include it — all three here share organization_id, so they
-- co-habit legally. Each has a composite PK (id, organization_id) including the partition key (ADR-0022
-- D1.1) + a DEFAULT partition so inserts work immediately (no orgs at migrate time); the M1 partition-
-- manager adds per-org leaves and the §3.2-Phase-F inner monthly RANGE(time) rotation later (deferred —
-- same rationale as 0074: the LIST key is the tenancy-isolation level that keeps the unique indexes legal).
--
-- claim_id / validation_run_id are LOGICAL FKs (plain uuid): claim (0074) and validation_run/result here
-- carry composite PKs that cannot be single-column FK targets, and validation_override (0075).result_id
-- already references validation_result logically for the same reason. organization_id → organization is
-- the only real FK. RLS/grants in 0077; M4 write-audit + append-only enforcement in 0079.

-- ============================================================================================
-- claim_state_history — immutable per-claim transition log. No unique index → no per-leaf helper.
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "claim_state_history" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"claim_id" uuid NOT NULL,
	"from_state" "claim_state",
	"to_state" "claim_state" NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_membership_id" uuid,
	"actor_kind" text NOT NULL,
	"reason" text,
	"validation_run_id" uuid,
	"submission_id" uuid,
	"acknowledgment_id" uuid,
	"remittance_advice_id" uuid,
	CONSTRAINT "claim_state_history_pk" PRIMARY KEY ("id","organization_id"),
	CONSTRAINT "claim_state_history_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict
) PARTITION BY LIST ("organization_id");--> statement-breakpoint
CREATE OR REPLACE FUNCTION create_claim_state_history_partition(p_organization_id uuid) RETURNS void AS $$
DECLARE partition_name text;
BEGIN
  partition_name := 'claim_state_history_org_' || replace(p_organization_id::text, '-', '');
  EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF claim_state_history FOR VALUES IN (%L)', partition_name, p_organization_id);
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DO $$ BEGIN
  EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF claim_state_history DEFAULT', 'claim_state_history_default');
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "claim_state_history_claim_at_idx" ON "claim_state_history" ("claim_id","at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "claim_state_history_org_at_idx" ON "claim_state_history" ("organization_id","at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "claim_state_history_recent_per_claim" ON "claim_state_history" ("claim_id","at" DESC);--> statement-breakpoint

-- ============================================================================================
-- validation_run (D1) — append-only; one per claim validation cycle. Idempotency unique INCLUDES the
-- partition key (organization_id) so it is a full unique on the partitioned parent (legal, global).
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "validation_run" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"claim_id" uuid NOT NULL,
	"trigger" "validation_run_trigger" NOT NULL,
	"outcome" "validation_run_outcome" NOT NULL,
	"run_input_hash" text NOT NULL,
	"rules_executed" integer NOT NULL,
	"rules_passed" integer NOT NULL,
	"rules_failed" integer NOT NULL,
	"rules_warn" integer NOT NULL,
	"rules_info" integer NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone NOT NULL,
	"duration_ms" integer NOT NULL,
	"initiated_by_membership_id" uuid,
	CONSTRAINT "validation_run_pk" PRIMARY KEY ("id","organization_id"),
	CONSTRAINT "validation_run_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict
) PARTITION BY LIST ("organization_id");--> statement-breakpoint
CREATE OR REPLACE FUNCTION create_validation_run_partition(p_organization_id uuid) RETURNS void AS $$
DECLARE partition_name text;
BEGIN
  partition_name := 'validation_run_org_' || replace(p_organization_id::text, '-', '');
  EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF validation_run FOR VALUES IN (%L)', partition_name, p_organization_id);
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DO $$ BEGIN
  EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF validation_run DEFAULT', 'validation_run_default');
END $$;--> statement-breakpoint
-- Idempotency: identical (org, claim_id, trigger, run_input_hash) collapses to one row (D1 / §2.6).
CREATE UNIQUE INDEX IF NOT EXISTS "validation_run_idempotency_uq" ON "validation_run" ("organization_id","claim_id","trigger","run_input_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "validation_run_claim_recent_idx" ON "validation_run" ("claim_id","started_at");--> statement-breakpoint

-- ============================================================================================
-- validation_result (D1) — append-only; one per (run, rule). No unique index → no per-leaf helper.
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "validation_result" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"validation_run_id" uuid NOT NULL,
	"rule_key" text NOT NULL,
	"rule_version" integer NOT NULL,
	"severity" "validation_severity" NOT NULL,
	"outcome" "validation_result_outcome" NOT NULL,
	"remediation" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"override_id" uuid,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "validation_result_pk" PRIMARY KEY ("id","organization_id"),
	CONSTRAINT "validation_result_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict
) PARTITION BY LIST ("organization_id");--> statement-breakpoint
CREATE OR REPLACE FUNCTION create_validation_result_partition(p_organization_id uuid) RETURNS void AS $$
DECLARE partition_name text;
BEGIN
  partition_name := 'validation_result_org_' || replace(p_organization_id::text, '-', '');
  EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF validation_result FOR VALUES IN (%L)', partition_name, p_organization_id);
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DO $$ BEGIN
  EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF validation_result DEFAULT', 'validation_result_default');
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "validation_result_run_idx" ON "validation_result" ("validation_run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "validation_result_failed_idx" ON "validation_result" ("organization_id","outcome") WHERE outcome = 'fail';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "validation_result_failed_per_claim" ON "validation_result" ("organization_id","validation_run_id") WHERE outcome = 'fail';
