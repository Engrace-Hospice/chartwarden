-- M30 HQRP & Quality §3.3 — `infection_surveillance_event` (PARTITIONED monthly by RANGE(observed_at);
-- retention class `phi`). Own file (single partition column per file; see 0063 header). Composite PK
-- (id, observed_at) includes the partition key. Per-event infection/exposure surveillance feeding
-- outbreak detection. The outbreak-lookup index INCLUDES observed_at and is non-unique → it lives on the
-- partitioned parent (no per-leaf indexes needed). provider_entity_id / location_id (ARCH-011
-- three-column rule) + patient_id (nullable; staff-exposure events) are cross-module logical FKs (plain
-- uuid). `exposure_source` (free-text identifying) + `outcome` are DENYLISTED in the 0068 write-audit
-- trigger (§3.6); the categorical pathogen/body_site/transmission_context are not. RLS+grants land in 0067.
CREATE TABLE IF NOT EXISTS "infection_surveillance_event" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"location_id" uuid,
	"patient_id" uuid,
	"observed_at" timestamp with time zone NOT NULL,
	"pathogen" text NOT NULL,
	"pathogen_confidence" text DEFAULT 'confirmed' NOT NULL,
	"body_site" text NOT NULL,
	"transmission_context" text NOT NULL,
	"exposure_source" text,
	"precautions_instituted" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"outcome" text,
	"filed_by_membership_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "infection_surveillance_event_pk" PRIMARY KEY ("id","observed_at"),
	CONSTRAINT "infection_surveillance_event_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict
) PARTITION BY RANGE ("observed_at");--> statement-breakpoint
CREATE OR REPLACE FUNCTION create_infection_surveillance_event_partition(start_date date) RETURNS void AS $$
DECLARE
  partition_name text;
  end_date date;
BEGIN
  partition_name := 'infection_surveillance_event_' || to_char(start_date, 'YYYY_MM');
  end_date := start_date + INTERVAL '1 month';
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I PARTITION OF infection_surveillance_event FOR VALUES FROM (%L) TO (%L)',
    partition_name, start_date, end_date
  );
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DO $$ BEGIN
  EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF infection_surveillance_event DEFAULT', 'infection_surveillance_event_default');
END $$;--> statement-breakpoint
DO $$ DECLARE i int; BEGIN
  FOR i IN 0..12 LOOP
    PERFORM create_infection_surveillance_event_partition((date_trunc('month', now()) + (i || ' month')::interval)::date);
  END LOOP;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_infection_outbreak_lookup" ON "infection_surveillance_event" ("provider_entity_id","pathogen","body_site","observed_at");
