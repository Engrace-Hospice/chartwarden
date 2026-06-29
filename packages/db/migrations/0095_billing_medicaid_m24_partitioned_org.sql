-- M24 Billing — Medicaid §3.3/§3.2 — the four org-partitioned tables: the append-only claim transition log,
-- the two validation tables (run + result), and the R&B billing day. All PARTITION BY LIST(organization_id).
-- In their OWN file (check-ddl-legality rule 1: ONE partition column per file, derived from the first
-- `PARTITION BY`; every UNIQUE/PK here includes organization_id, so they co-habit legally). Each carries a
-- composite PK (id, organization_id) including the partition key + a DEFAULT partition so inserts work
-- immediately; the M1 partition-manager adds per-org leaves later (M23 0076 precedent).
--
-- CROSS-MODULE / partitioned-parent FK POLICY: organization_id → organization is the only real FK on the
-- log/validation tables; rb_day additionally keeps a real FK to the non-partitioned rb_arrangement parent.
-- medicaid_claim_id / medicaid_validation_run_id (partitioned parents), patient_id / loc_period_id_snapshot
-- (M5/M6), medicaid_claim_line_id (partitioned) are LOGICAL uuid.

-- ============================================================================================
-- medicaid_claim_state_history — append-only per-claim transition log
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "medicaid_claim_state_history" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"medicaid_claim_id" uuid NOT NULL,
	"from_state" "m24_claim_state",
	"to_state" "m24_claim_state" NOT NULL,
	"reason" text,
	"trigger_source" varchar(32) NOT NULL,
	"actor_membership_id" uuid,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "medicaid_claim_state_history_pk" PRIMARY KEY ("id","organization_id"),
	CONSTRAINT "medicaid_claim_state_history_org_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict
) PARTITION BY LIST ("organization_id");--> statement-breakpoint
CREATE OR REPLACE FUNCTION create_medicaid_claim_state_history_partition(p_organization_id uuid) RETURNS void AS $$
DECLARE partition_name text;
BEGIN
  partition_name := 'medicaid_claim_state_history_org_' || replace(p_organization_id::text, '-', '');
  EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF medicaid_claim_state_history FOR VALUES IN (%L)', partition_name, p_organization_id);
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DO $$ BEGIN
  EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF medicaid_claim_state_history DEFAULT', 'medicaid_claim_state_history_default');
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "medicaid_claim_state_history_by_claim_at" ON "medicaid_claim_state_history" ("medicaid_claim_id","at" DESC);--> statement-breakpoint

-- ============================================================================================
-- medicaid_validation_run — one per validation cycle
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "medicaid_validation_run" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"medicaid_claim_id" uuid NOT NULL,
	"rule_registry_version" varchar(16) NOT NULL,
	"triggered_by" varchar(32) NOT NULL,
	"trigger_signal_id" varchar(128),
	"claim_state_at_trigger" "m24_claim_state" NOT NULL,
	"idempotency_key" varchar(200) NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_membership_id" uuid,
	"completed_at" timestamp with time zone,
	"total_results" integer DEFAULT 0 NOT NULL,
	"failed_results" integer DEFAULT 0 NOT NULL,
	"warned_results" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "medicaid_validation_run_pk" PRIMARY KEY ("id","organization_id"),
	CONSTRAINT "medicaid_validation_run_org_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict
) PARTITION BY LIST ("organization_id");--> statement-breakpoint
CREATE OR REPLACE FUNCTION create_medicaid_validation_run_partition(p_organization_id uuid) RETURNS void AS $$
DECLARE partition_name text;
BEGIN
  partition_name := 'medicaid_validation_run_org_' || replace(p_organization_id::text, '-', '');
  EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF medicaid_validation_run FOR VALUES IN (%L)', partition_name, p_organization_id);
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DO $$ BEGIN
  EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF medicaid_validation_run DEFAULT', 'medicaid_validation_run_default');
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "medicaid_validation_run_unique_idempotency" ON "medicaid_validation_run" ("organization_id","medicaid_claim_id","idempotency_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "medicaid_validation_run_by_claim_at" ON "medicaid_validation_run" ("medicaid_claim_id","at" DESC);--> statement-breakpoint

-- ============================================================================================
-- medicaid_validation_result — one per rule per run
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "medicaid_validation_result" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"medicaid_validation_run_id" uuid NOT NULL,
	"rule_key" varchar(96) NOT NULL,
	"rule_version" integer NOT NULL,
	"applicable_states_check" jsonb,
	"outcome" "m24_validation_outcome" NOT NULL,
	"remediation_summary" text,
	"remediation_blame_target" varchar(32),
	"remediation_blame_target_id" uuid,
	"remediation_fix_action" varchar(64),
	"remediation_fix_deep_link" text,
	"details_json" jsonb,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "medicaid_validation_result_pk" PRIMARY KEY ("id","organization_id"),
	CONSTRAINT "medicaid_validation_result_org_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict
) PARTITION BY LIST ("organization_id");--> statement-breakpoint
CREATE OR REPLACE FUNCTION create_medicaid_validation_result_partition(p_organization_id uuid) RETURNS void AS $$
DECLARE partition_name text;
BEGIN
  partition_name := 'medicaid_validation_result_org_' || replace(p_organization_id::text, '-', '');
  EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF medicaid_validation_result FOR VALUES IN (%L)', partition_name, p_organization_id);
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DO $$ BEGIN
  EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF medicaid_validation_result DEFAULT', 'medicaid_validation_result_default');
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "medicaid_validation_result_unique_per_run" ON "medicaid_validation_result" ("organization_id","medicaid_validation_run_id","rule_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "medicaid_validation_result_by_run_outcome" ON "medicaid_validation_result" ("medicaid_validation_run_id","outcome");--> statement-breakpoint

-- ============================================================================================
-- rb_day — per-patient-per-service-date R&B billing day (real FK to non-partitioned rb_arrangement)
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "rb_day" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"location_id" uuid,
	"patient_id" uuid NOT NULL,
	"rb_arrangement_id" uuid NOT NULL,
	"service_date" timestamp with time zone NOT NULL,
	"loc_of_day" "m24_claim_line_loc" NOT NULL,
	"loc_period_id_snapshot" uuid NOT NULL,
	"per_diem_cents_snapshot" integer NOT NULL,
	"status" "m24_rb_day_status" DEFAULT 'pending' NOT NULL,
	"exclusion_reason" text,
	"medicaid_claim_line_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rb_day_pk" PRIMARY KEY ("id","organization_id"),
	CONSTRAINT "rb_day_org_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "rb_day_pe_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict,
	CONSTRAINT "rb_day_location_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict,
	CONSTRAINT "rb_day_arrangement_fk" FOREIGN KEY ("rb_arrangement_id") REFERENCES "public"."rb_arrangement"("id") ON DELETE restrict,
	CONSTRAINT "rb_day_billed_requires_claim_line" CHECK ((status != 'billed') OR (status = 'billed' AND medicaid_claim_line_id IS NOT NULL))
) PARTITION BY LIST ("organization_id");--> statement-breakpoint
CREATE OR REPLACE FUNCTION create_rb_day_partition(p_organization_id uuid) RETURNS void AS $$
DECLARE partition_name text;
BEGIN
  partition_name := 'rb_day_org_' || replace(p_organization_id::text, '-', '');
  EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF rb_day FOR VALUES IN (%L)', partition_name, p_organization_id);
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DO $$ BEGIN
  EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF rb_day DEFAULT', 'rb_day_default');
END $$;--> statement-breakpoint
-- one non-voided billing day per patient per service date (partial unique INCLUDES the partition key org_id)
CREATE UNIQUE INDEX IF NOT EXISTS "rb_day_unique_per_patient_service_date" ON "rb_day" ("organization_id","patient_id","service_date") WHERE status != 'voided';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rb_day_by_arrangement_date" ON "rb_day" ("rb_arrangement_id","service_date");--> statement-breakpoint
