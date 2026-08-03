-- M37 §3.3 — the two `at`-partitioned append-only ledgers: ipu_admission_state_history and
-- ipu_bed_cleaning_event. BOTH partition monthly by `at`, so they share ONE file (check-ddl-legality
-- rule 1 derives a single partition column per file and requires every PK/UNIQUE in the file to include
-- it — here both composite PKs are `(id, at)`). RLS/grants + the GENERATED parent-hardcoded write-audit
-- triggers land in 0153 on the PARENT and propagate to every partition (PG11+; the M32 ai_token_ledger
-- lesson: a partitioned table must NOT use M1's baseline trigger, which would stamp TG_TABLE_NAME = the
-- dated partition).
CREATE TABLE IF NOT EXISTS "ipu_admission_state_history" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "ipu_admission_id" uuid NOT NULL,
  "from_state" "ipu_admission_state",
  "to_state" "ipu_admission_state" NOT NULL,
  "at" timestamp with time zone DEFAULT now() NOT NULL,
  "by_membership_id" uuid NOT NULL,
  "reason" text,
  "metadata" jsonb,
  CONSTRAINT "ipu_admission_state_history_pkey" PRIMARY KEY ("id","at")
) PARTITION BY RANGE ("at");--> statement-breakpoint
CREATE OR REPLACE FUNCTION create_ipu_admission_state_history_partition(start_date date) RETURNS void AS $$
DECLARE partition_name text; end_date date;
BEGIN
  partition_name := 'ipu_admission_state_history_' || to_char(start_date, 'YYYY_MM');
  end_date := start_date + INTERVAL '1 month';
  EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF ipu_admission_state_history FOR VALUES FROM (%L) TO (%L)', partition_name, start_date, end_date);
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DO $$ BEGIN EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF ipu_admission_state_history DEFAULT', 'ipu_admission_state_history_default'); END $$;--> statement-breakpoint
DO $$ DECLARE i int; BEGIN FOR i IN 0..12 LOOP PERFORM create_ipu_admission_state_history_partition((date_trunc('month', now()) + (i || ' month')::interval)::date); END LOOP; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ipu_admission_state_history_admission_at_idx" ON "ipu_admission_state_history" ("ipu_admission_id","at");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "ipu_bed_cleaning_event" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "bed_id" uuid NOT NULL,
  "from_status" "ipu_bed_cleaning_status",
  "to_status" "ipu_bed_cleaning_status" NOT NULL,
  "at" timestamp with time zone DEFAULT now() NOT NULL,
  "by_membership_id" uuid,
  "notes" text,
  CONSTRAINT "ipu_bed_cleaning_event_pkey" PRIMARY KEY ("id","at")
) PARTITION BY RANGE ("at");--> statement-breakpoint
CREATE OR REPLACE FUNCTION create_ipu_bed_cleaning_event_partition(start_date date) RETURNS void AS $$
DECLARE partition_name text; end_date date;
BEGIN
  partition_name := 'ipu_bed_cleaning_event_' || to_char(start_date, 'YYYY_MM');
  end_date := start_date + INTERVAL '1 month';
  EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF ipu_bed_cleaning_event FOR VALUES FROM (%L) TO (%L)', partition_name, start_date, end_date);
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DO $$ BEGIN EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF ipu_bed_cleaning_event DEFAULT', 'ipu_bed_cleaning_event_default'); END $$;--> statement-breakpoint
DO $$ DECLARE i int; BEGIN FOR i IN 0..12 LOOP PERFORM create_ipu_bed_cleaning_event_partition((date_trunc('month', now()) + (i || ' month')::interval)::date); END LOOP; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ipu_bed_cleaning_event_bed_at_idx" ON "ipu_bed_cleaning_event" ("bed_id","at");
