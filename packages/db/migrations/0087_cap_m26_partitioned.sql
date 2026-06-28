-- M26 Cap Management §3.2 Phase 3 (cont.) — the three append-only PARTITION BY LIST(cap_period_id) tables
-- in their OWN migration file: check-ddl-legality rule 1 derives ONE partition column per file from the
-- first PARTITION BY and then requires every UNIQUE/PK in the file to include it — all three partition on
-- cap_period_id and each carries a composite PK (id, cap_period_id) + a cap_period_id-leading UNIQUE, so
-- they co-habit legally (the M25 0082 / M23 0076 / M30 incident_report precedent).
--
-- Each table gets a create_<t>_partition(p_cap_period_id uuid) helper + a DEFAULT partition so inserts work
-- immediately (no per-period leaf required at open). When a cap period opens, the service layer calls the
-- helper to attach a dedicated leaf; a settled period's leaf can be ATTACH/DETACH-archived without touching
-- live data (§3.2). Indexes declared on the PARENT propagate to every partition (PG11+). cap_period_id is a
-- LOGICAL uuid (a real FK from a LIST-partitioned child onto cap_period adds no value here); organization_id
-- is the only real FK. patient_id (M5) / source_id (M23/M25) / snapshot lineage are logical.

-- ============================================================================================
-- cap_beneficiary_accrual_line — append-only remittance-derived cap contributions
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "cap_beneficiary_accrual_line" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"cap_period_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"source_kind" "m26_line_source_kind" NOT NULL,
	"source_id" uuid NOT NULL,
	"source_line_seq" integer DEFAULT 0 NOT NULL,
	"amount_cents" bigint NOT NULL,
	"service_from" date NOT NULL,
	"service_to" date NOT NULL,
	"posted_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"recorded_by" uuid,
	"reversal_of_line_id" uuid,
	"reason" text,
	CONSTRAINT "cap_beneficiary_accrual_line_pk" PRIMARY KEY ("id", "cap_period_id"),
	CONSTRAINT "cap_ben_accrual_line_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "cap_ben_accrual_line_source_uq" UNIQUE ("cap_period_id", "source_kind", "source_id", "source_line_seq"),
	CONSTRAINT "cap_ben_accrual_line_dates_ck" CHECK ("service_to" >= "service_from"),
	CONSTRAINT "cap_ben_accrual_line_manual_ck" CHECK ("source_kind" <> 'manual_correction' OR "recorded_by" IS NOT NULL)
) PARTITION BY LIST ("cap_period_id");--> statement-breakpoint
CREATE OR REPLACE FUNCTION create_cap_beneficiary_accrual_line_partition(p_cap_period_id uuid) RETURNS void AS $$
DECLARE partition_name text;
BEGIN
  partition_name := 'cap_ben_accrual_line_' || replace(p_cap_period_id::text, '-', '');
  EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF cap_beneficiary_accrual_line FOR VALUES IN (%L)', partition_name, p_cap_period_id);
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DO $$ BEGIN EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF cap_beneficiary_accrual_line DEFAULT', 'cap_beneficiary_accrual_line_default'); END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cap_ben_accrual_line_period_patient_ix" ON "cap_beneficiary_accrual_line" ("cap_period_id", "patient_id", "posted_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cap_ben_accrual_line_posted_ix" ON "cap_beneficiary_accrual_line" USING brin ("posted_at");--> statement-breakpoint

-- ============================================================================================
-- cap_inpatient_day_line — append-only GIP(0656)/IRC(0655) claim-line days
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "cap_inpatient_day_line" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"cap_period_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"source_kind" "m26_inpatient_source_kind" DEFAULT 'claim_line' NOT NULL,
	"source_id" uuid NOT NULL,
	"rev_code" char(4) NOT NULL,
	"days" smallint NOT NULL,
	"service_from" date NOT NULL,
	"service_to" date NOT NULL,
	"posted_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"recorded_by" uuid,
	CONSTRAINT "cap_inpatient_day_line_pk" PRIMARY KEY ("id", "cap_period_id"),
	CONSTRAINT "cap_inp_day_line_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "cap_inp_day_line_source_uq" UNIQUE ("cap_period_id", "source_kind", "source_id", "rev_code"),
	CONSTRAINT "cap_inp_day_line_rev_ck" CHECK ("rev_code" IN ('0655', '0656')),
	CONSTRAINT "cap_inp_day_line_dates_ck" CHECK ("service_to" >= "service_from"),
	CONSTRAINT "cap_inp_day_line_days_ck" CHECK ("days" >= 0)
) PARTITION BY LIST ("cap_period_id");--> statement-breakpoint
CREATE OR REPLACE FUNCTION create_cap_inpatient_day_line_partition(p_cap_period_id uuid) RETURNS void AS $$
DECLARE partition_name text;
BEGIN
  partition_name := 'cap_inp_day_line_' || replace(p_cap_period_id::text, '-', '');
  EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF cap_inpatient_day_line FOR VALUES IN (%L)', partition_name, p_cap_period_id);
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DO $$ BEGIN EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF cap_inpatient_day_line DEFAULT', 'cap_inpatient_day_line_default'); END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cap_inp_day_line_period_ix" ON "cap_inpatient_day_line" ("cap_period_id", "service_from");--> statement-breakpoint

-- ============================================================================================
-- cap_projection_snapshot — append-only projection ledger (latest-per-scope reads)
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "cap_projection_snapshot" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"cap_period_id" uuid NOT NULL,
	"scope" "m26_projection_scope" NOT NULL,
	"patient_id" uuid,
	"methodology" "m26_methodology" NOT NULL,
	"paid_ytd_cents" bigint NOT NULL,
	"outstanding_billed_cents" bigint DEFAULT 0 NOT NULL,
	"projected_year_end_cents" bigint NOT NULL,
	"cap_amount_cents" bigint,
	"inpatient_days_ytd" integer,
	"inpatient_pct_ytd" numeric(7, 4),
	"inpatient_pct_projected" numeric(7, 4),
	"pct_of_cap" numeric(7, 4) NOT NULL,
	"alert_band" "m26_alert_band" NOT NULL,
	"beneficiary_count" integer,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"computed_by" "m26_projection_trigger" NOT NULL,
	CONSTRAINT "cap_projection_snapshot_pk" PRIMARY KEY ("id", "cap_period_id"),
	CONSTRAINT "cap_projection_snapshot_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "cap_projection_snapshot_uq" UNIQUE ("cap_period_id", "scope", "patient_id", "computed_at")
) PARTITION BY LIST ("cap_period_id");--> statement-breakpoint
CREATE OR REPLACE FUNCTION create_cap_projection_snapshot_partition(p_cap_period_id uuid) RETURNS void AS $$
DECLARE partition_name text;
BEGIN
  partition_name := 'cap_projection_snapshot_' || replace(p_cap_period_id::text, '-', '');
  EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF cap_projection_snapshot FOR VALUES IN (%L)', partition_name, p_cap_period_id);
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DO $$ BEGIN EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF cap_projection_snapshot DEFAULT', 'cap_projection_snapshot_default'); END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cap_projection_snapshot_latest_ix" ON "cap_projection_snapshot" ("organization_id", "cap_period_id", "scope", "patient_id", "computed_at");
