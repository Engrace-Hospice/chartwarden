-- M30 HQRP & Quality §3.3 — `mortality_review` (PARTITIONED monthly by RANGE(death_at); retention class
-- `phi`). Own file (single partition column per file; see 0063 header). Composite PK (id, death_at)
-- includes the partition key. Created once per admission via an idempotent death event.
--
-- Per-LEAF backstops (EVV precedent): the per-admission UNIQUE (admission_id) and the per-idempotency-key
-- UNIQUE (created_via_event_idempotency_key) BOTH omit the partition key (death_at), so they cannot be
-- UNIQUE on the partitioned PARENT; add_mortality_review_unique_indexes() adds them per leaf. The plain
-- by-admission / by-idem lookup indexes live on the parent. deceased_patient_id / admission_id / linked
-- QAPI project / document_id are cross-module logical FKs (plain uuid). The three free-text dimension
-- jsonb columns (clinical_dimension_data, satisfaction_dimension_data, compliance_dimension_data) are
-- DENYLISTED in the 0068 write-audit trigger (§3.6). RLS+grants land in 0067.
CREATE TABLE IF NOT EXISTS "mortality_review" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"deceased_patient_id" uuid NOT NULL,
	"admission_id" uuid NOT NULL,
	"death_at" timestamp with time zone NOT NULL,
	"status" "m30_mortality_review_status" DEFAULT 'pending' NOT NULL,
	"assigned_reviewer_membership_id" uuid,
	"clinical_dimension_data" jsonb,
	"satisfaction_dimension_data" jsonb,
	"compliance_dimension_data" jsonb,
	"reviewer_signature_at" timestamp with time zone,
	"target_completion_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"linked_qapi_project_id" uuid,
	"document_id" uuid,
	"created_via_event_idempotency_key" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "mortality_review_pk" PRIMARY KEY ("id","death_at"),
	CONSTRAINT "mortality_review_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict
) PARTITION BY RANGE ("death_at");--> statement-breakpoint
CREATE OR REPLACE FUNCTION add_mortality_review_unique_indexes(partition_name text) RETURNS void AS $$
BEGIN
  EXECUTE format(
    'CREATE UNIQUE INDEX IF NOT EXISTS %I ON %I (admission_id)',
    partition_name || '_per_admission_uidx', partition_name
  );
  EXECUTE format(
    'CREATE UNIQUE INDEX IF NOT EXISTS %I ON %I (created_via_event_idempotency_key)',
    partition_name || '_idem_uidx', partition_name
  );
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE OR REPLACE FUNCTION create_mortality_review_partition(start_date date) RETURNS void AS $$
DECLARE
  partition_name text;
  end_date date;
BEGIN
  partition_name := 'mortality_review_' || to_char(start_date, 'YYYY_MM');
  end_date := start_date + INTERVAL '1 month';
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I PARTITION OF mortality_review FOR VALUES FROM (%L) TO (%L)',
    partition_name, start_date, end_date
  );
  PERFORM add_mortality_review_unique_indexes(partition_name);
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DO $$ BEGIN
  EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF mortality_review DEFAULT', 'mortality_review_default');
  PERFORM add_mortality_review_unique_indexes('mortality_review_default');
END $$;--> statement-breakpoint
DO $$ DECLARE i int; BEGIN
  FOR i IN 0..12 LOOP
    PERFORM create_mortality_review_partition((date_trunc('month', now()) + (i || ' month')::interval)::date);
  END LOOP;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_mortality_review_by_admission" ON "mortality_review" ("admission_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_mortality_review_idem" ON "mortality_review" ("created_via_event_idempotency_key");
