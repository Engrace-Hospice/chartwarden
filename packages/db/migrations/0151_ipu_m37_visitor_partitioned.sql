-- M37 §3.3 — ipu_visitor, monthly PARTITION BY RANGE (checked_in_at). Own file (its partition column
-- differs from 0150's `at`). visitor_name / relationship_other_text / restriction_applied_text are
-- §3.6-denylisted free-text PHI, scrubbed by the GENERATED parent-hardcoded write-audit trigger in 0153.
CREATE TABLE IF NOT EXISTS "ipu_visitor" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "ipu_admission_id" uuid NOT NULL,
  "visitor_name" text NOT NULL,
  "relationship" "ipu_visitor_relationship" NOT NULL,
  "relationship_other_text" text,
  "screening_outcome" jsonb NOT NULL,
  "consent_evaluator_result" jsonb NOT NULL,
  "checked_in_at" timestamp with time zone DEFAULT now() NOT NULL,
  "checked_in_by" uuid NOT NULL,
  "checked_out_at" timestamp with time zone,
  "mask_required" boolean DEFAULT false NOT NULL,
  "restriction_applied_text" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "version" bigint DEFAULT 0 NOT NULL,
  CONSTRAINT "ipu_visitor_pkey" PRIMARY KEY ("id","checked_in_at")
) PARTITION BY RANGE ("checked_in_at");--> statement-breakpoint
CREATE OR REPLACE FUNCTION create_ipu_visitor_partition(start_date date) RETURNS void AS $$
DECLARE partition_name text; end_date date;
BEGIN
  partition_name := 'ipu_visitor_' || to_char(start_date, 'YYYY_MM');
  end_date := start_date + INTERVAL '1 month';
  EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF ipu_visitor FOR VALUES FROM (%L) TO (%L)', partition_name, start_date, end_date);
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DO $$ BEGIN EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF ipu_visitor DEFAULT', 'ipu_visitor_default'); END $$;--> statement-breakpoint
DO $$ DECLARE i int; BEGIN FOR i IN 0..12 LOOP PERFORM create_ipu_visitor_partition((date_trunc('month', now()) + (i || ' month')::interval)::date); END LOOP; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ipu_visitor_admission_checked_in_idx" ON "ipu_visitor" ("ipu_admission_id","checked_in_at");
