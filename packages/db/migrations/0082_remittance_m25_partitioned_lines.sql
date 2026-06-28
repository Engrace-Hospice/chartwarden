-- M25 Remittance & Denials §3.2 Phase C — the four PHI-bearing posting tables, all MONTHLY
-- PARTITION BY RANGE(received_at) (D11), in their OWN migration file: check-ddl-legality rule 1 derives
-- ONE partition column per file from the first PARTITION BY and then requires every UNIQUE/PK in the file
-- to include it — all four here partition on received_at and each has a composite PK (id, received_at)
-- that includes it, so they co-habit legally (the M30 incident_report / M23 0076 precedent).
--
-- Each table gets: a create_<t>_partition(start_date) helper, a DEFAULT partition so inserts work
-- immediately, and 0..12 monthly leaves seeded from date_trunc('month', now()). The M1 partition manager
-- rotates new months and rolls leaves to warm storage after 24 months (architecture §24.1). Indexes are
-- declared on the PARENT and propagate to every partition (PG11+). organization_id → organization is the
-- only real FK; all line/claim/denial/membership references are LOGICAL uuid (cross-module or onto the
-- partitioned siblings — a real FK onto a RANGE-partitioned parent would have to carry received_at).

-- ============================================================================================
-- remittance_line — one per CLP claim-payment segment.
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "remittance_line" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"remittance_advice_id" uuid NOT NULL,
	"claim_id" uuid,
	"clp01_patient_control_number" varchar(38),
	"clp07_payer_icn" varchar(38),
	"clp02_status_code" smallint NOT NULL,
	"clp03_total_charge_amount" numeric(12, 2) NOT NULL,
	"clp04_total_payment_amount" numeric(12, 2) NOT NULL,
	"clp05_patient_responsibility_amount" numeric(12, 2) DEFAULT '0' NOT NULL,
	"match_state" "m25_match_state" DEFAULT 'unmatched' NOT NULL,
	"match_strategy" "m25_match_strategy",
	"match_confidence" smallint,
	"matched_at" timestamp with time zone,
	"matched_by_membership_id" uuid,
	"received_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "remittance_line_pk" PRIMARY KEY ("id","received_at"),
	CONSTRAINT "remittance_line_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict
) PARTITION BY RANGE ("received_at");--> statement-breakpoint
CREATE OR REPLACE FUNCTION create_remittance_line_partition(start_date date) RETURNS void AS $$
DECLARE partition_name text; end_date date;
BEGIN
  partition_name := 'remittance_line_' || to_char(start_date, 'YYYY_MM');
  end_date := start_date + INTERVAL '1 month';
  EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF remittance_line FOR VALUES FROM (%L) TO (%L)', partition_name, start_date, end_date);
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DO $$ BEGIN EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF remittance_line DEFAULT', 'remittance_line_default'); END $$;--> statement-breakpoint
DO $$ DECLARE i int; BEGIN FOR i IN 0..12 LOOP PERFORM create_remittance_line_partition((date_trunc('month', now()) + (i || ' month')::interval)::date); END LOOP; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_remittance_line_advice" ON "remittance_line" ("remittance_advice_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_remittance_line_claim" ON "remittance_line" ("claim_id") WHERE claim_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_remittance_line_payer_icn" ON "remittance_line" ("clp07_payer_icn") WHERE clp07_payer_icn IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_remittance_line_match_state" ON "remittance_line" ("match_state");--> statement-breakpoint

-- ============================================================================================
-- remittance_service_line — one per SVC sub-segment.
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "remittance_service_line" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"remittance_line_id" uuid NOT NULL,
	"svc01_procedure_code" varchar(12),
	"svc01_revenue_code" varchar(4),
	"svc02_charge_amount" numeric(12, 2) NOT NULL,
	"svc03_paid_amount" numeric(12, 2) NOT NULL,
	"svc05_paid_units" smallint,
	"svc07_submitted_units" smallint,
	"claim_line_ref" jsonb,
	"received_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "remittance_service_line_pk" PRIMARY KEY ("id","received_at"),
	CONSTRAINT "remittance_service_line_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict
) PARTITION BY RANGE ("received_at");--> statement-breakpoint
CREATE OR REPLACE FUNCTION create_remittance_service_line_partition(start_date date) RETURNS void AS $$
DECLARE partition_name text; end_date date;
BEGIN
  partition_name := 'remittance_service_line_' || to_char(start_date, 'YYYY_MM');
  end_date := start_date + INTERVAL '1 month';
  EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF remittance_service_line FOR VALUES FROM (%L) TO (%L)', partition_name, start_date, end_date);
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DO $$ BEGIN EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF remittance_service_line DEFAULT', 'remittance_service_line_default'); END $$;--> statement-breakpoint
DO $$ DECLARE i int; BEGIN FOR i IN 0..12 LOOP PERFORM create_remittance_service_line_partition((date_trunc('month', now()) + (i || ' month')::interval)::date); END LOOP; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_remittance_svcline_line" ON "remittance_service_line" ("remittance_line_id");--> statement-breakpoint

-- ============================================================================================
-- remittance_adjustment — one per CAS segment (claim- OR service-line level; xor).
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "remittance_adjustment" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"remittance_line_id" uuid,
	"remittance_service_line_id" uuid,
	"cas_group_code" "m25_cas_group_code" NOT NULL,
	"cas_reason_code" varchar(8) NOT NULL,
	"adjustment_amount" numeric(12, 2) NOT NULL,
	"adjustment_quantity" smallint,
	"post_action" "m25_post_action" NOT NULL,
	"taxonomy_status" "m25_taxonomy_status" NOT NULL,
	"denial_case_id" uuid,
	"received_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "remittance_adjustment_pk" PRIMARY KEY ("id","received_at"),
	CONSTRAINT "remittance_adjustment_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "remittance_adjustment_level_xor" CHECK (("remittance_line_id" IS NULL) <> ("remittance_service_line_id" IS NULL))
) PARTITION BY RANGE ("received_at");--> statement-breakpoint
CREATE OR REPLACE FUNCTION create_remittance_adjustment_partition(start_date date) RETURNS void AS $$
DECLARE partition_name text; end_date date;
BEGIN
  partition_name := 'remittance_adjustment_' || to_char(start_date, 'YYYY_MM');
  end_date := start_date + INTERVAL '1 month';
  EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF remittance_adjustment FOR VALUES FROM (%L) TO (%L)', partition_name, start_date, end_date);
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DO $$ BEGIN EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF remittance_adjustment DEFAULT', 'remittance_adjustment_default'); END $$;--> statement-breakpoint
DO $$ DECLARE i int; BEGIN FOR i IN 0..12 LOOP PERFORM create_remittance_adjustment_partition((date_trunc('month', now()) + (i || ' month')::interval)::date); END LOOP; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_adjustment_line" ON "remittance_adjustment" ("remittance_line_id") WHERE remittance_line_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_adjustment_svcline" ON "remittance_adjustment" ("remittance_service_line_id") WHERE remittance_service_line_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_adjustment_carc" ON "remittance_adjustment" ("cas_reason_code");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_adjustment_denial_case" ON "remittance_adjustment" ("denial_case_id") WHERE denial_case_id IS NOT NULL;--> statement-breakpoint

-- ============================================================================================
-- remittance_remark — one per LQ/MIA/MOA segment. free_text audit-denylisted (§3.6).
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "remittance_remark" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"remittance_line_id" uuid,
	"remittance_service_line_id" uuid,
	"remark_kind" "m25_remark_kind" NOT NULL,
	"remark_code" varchar(8) NOT NULL,
	"free_text" varchar(2000),
	"received_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "remittance_remark_pk" PRIMARY KEY ("id","received_at"),
	CONSTRAINT "remittance_remark_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict
) PARTITION BY RANGE ("received_at");--> statement-breakpoint
CREATE OR REPLACE FUNCTION create_remittance_remark_partition(start_date date) RETURNS void AS $$
DECLARE partition_name text; end_date date;
BEGIN
  partition_name := 'remittance_remark_' || to_char(start_date, 'YYYY_MM');
  end_date := start_date + INTERVAL '1 month';
  EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF remittance_remark FOR VALUES FROM (%L) TO (%L)', partition_name, start_date, end_date);
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DO $$ BEGIN EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF remittance_remark DEFAULT', 'remittance_remark_default'); END $$;--> statement-breakpoint
DO $$ DECLARE i int; BEGIN FOR i IN 0..12 LOOP PERFORM create_remittance_remark_partition((date_trunc('month', now()) + (i || ' month')::interval)::date); END LOOP; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_remark_line" ON "remittance_remark" ("remittance_line_id") WHERE remittance_line_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_remark_rarc" ON "remittance_remark" ("remark_code");
