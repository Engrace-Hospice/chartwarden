-- M30 HQRP & Quality §3.3 — `cahps_decedent_sample` (PARTITIONED monthly by RANGE(sampling_cycle_month),
-- a `date` partition key; retention class `phi`). Own file (single partition column per file; see 0063
-- header). Composite PK (id, sampling_cycle_month) includes the partition key. The CMS CAHPS decedent
-- sampling roster: one row per sampled decedent per monthly cycle, holding the envelope-encrypted
-- primary-caregiver contact for vendor export.
--
-- The decedent UNIQUE (provider_entity_id, sampling_cycle_month, deceased_admission_id) INCLUDES the
-- partition key, so it is a valid UNIQUE on the partitioned PARENT (no per-leaf index needed).
-- deceased_admission_id / deceased_patient_id are cross-module logical FKs (M6 / M5, plain uuid).
-- `primary_caregiver_contact_cipher` is ciphertext PHI → DENYLISTED in the 0068 write-audit trigger
-- (§3.6). RLS+grants land in 0067.
CREATE TABLE IF NOT EXISTS "cahps_decedent_sample" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"sampling_cycle_month" date NOT NULL,
	"deceased_admission_id" uuid NOT NULL,
	"deceased_patient_id" uuid NOT NULL,
	"primary_caregiver_contact_cipher" text NOT NULL,
	"primary_caregiver_contact_key_version" integer NOT NULL,
	"exclusion_reason" text,
	"status" "m30_cahps_sample_status" DEFAULT 'pending_export' NOT NULL,
	"exported_at" timestamp with time zone,
	"vendor_ack_ref" text,
	"vendor_acked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cahps_decedent_sample_pk" PRIMARY KEY ("id","sampling_cycle_month"),
	CONSTRAINT "cahps_decedent_sample_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict
) PARTITION BY RANGE ("sampling_cycle_month");--> statement-breakpoint
CREATE OR REPLACE FUNCTION create_cahps_decedent_sample_partition(start_date date) RETURNS void AS $$
DECLARE
  partition_name text;
  end_date date;
BEGIN
  partition_name := 'cahps_decedent_sample_' || to_char(start_date, 'YYYY_MM');
  end_date := start_date + INTERVAL '1 month';
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I PARTITION OF cahps_decedent_sample FOR VALUES FROM (%L) TO (%L)',
    partition_name, start_date, end_date
  );
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DO $$ BEGIN
  EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF cahps_decedent_sample DEFAULT', 'cahps_decedent_sample_default');
END $$;--> statement-breakpoint
DO $$ DECLARE i int; BEGIN
  FOR i IN 0..12 LOOP
    PERFORM create_cahps_decedent_sample_partition((date_trunc('month', now()) + (i || ' month')::interval)::date);
  END LOOP;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_cahps_sample_decedent" ON "cahps_decedent_sample" ("provider_entity_id","sampling_cycle_month","deceased_admission_id");
