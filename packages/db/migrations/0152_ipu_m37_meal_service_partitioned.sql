-- M37 §3.3 — ipu_meal_service, monthly PARTITION BY RANGE (service_date). Own file (partition column
-- `service_date` differs from 0150/0151). refusal_reason is §3.6-denylisted free-text PHI, scrubbed by
-- the GENERATED parent-hardcoded write-audit trigger in 0153. intake_fraction BETWEEN 0 AND 1 CHECK.
CREATE TABLE IF NOT EXISTS "ipu_meal_service" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "ipu_admission_id" uuid NOT NULL,
  "service_date" date NOT NULL,
  "meal_slot" "ipu_meal_slot" NOT NULL,
  "diet_order_id" uuid,
  "tray_delivered_at" timestamp with time zone,
  "tray_removed_at" timestamp with time zone,
  "intake_fraction" numeric(3, 2),
  "refusal_reason" text,
  "caregiver_assisted_feeding" boolean DEFAULT false NOT NULL,
  "oral_care_completed" boolean DEFAULT false NOT NULL,
  "recorded_by" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "version" bigint DEFAULT 0 NOT NULL,
  CONSTRAINT "ipu_meal_service_pkey" PRIMARY KEY ("id","service_date"),
  CONSTRAINT "ipu_meal_service_intake_chk" CHECK ("intake_fraction" IS NULL OR ("intake_fraction" >= 0 AND "intake_fraction" <= 1))
) PARTITION BY RANGE ("service_date");--> statement-breakpoint
CREATE OR REPLACE FUNCTION create_ipu_meal_service_partition(start_date date) RETURNS void AS $$
DECLARE partition_name text; end_date date;
BEGIN
  partition_name := 'ipu_meal_service_' || to_char(start_date, 'YYYY_MM');
  end_date := start_date + INTERVAL '1 month';
  EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF ipu_meal_service FOR VALUES FROM (%L) TO (%L)', partition_name, start_date, end_date);
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DO $$ BEGIN EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF ipu_meal_service DEFAULT', 'ipu_meal_service_default'); END $$;--> statement-breakpoint
DO $$ DECLARE i int; BEGIN FOR i IN 0..12 LOOP PERFORM create_ipu_meal_service_partition((date_trunc('month', now()) + (i || ' month')::interval)::date); END LOOP; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ipu_meal_service_admission_date_idx" ON "ipu_meal_service" ("ipu_admission_id","service_date");
