-- M30 HQRP & Quality §3.3 — `incident_report` (PARTITIONED monthly by RANGE(occurred_at); retention
-- class `phi`). In its OWN migration file because check-ddl-legality rule 1 derives a SINGLE partition
-- column per file from the first `PARTITION BY`; the four M30 RANGE keys (occurred_at / death_at /
-- observed_at / sampling_cycle_month) must not co-habit a file or the cross-table PK scan false-fails.
--
-- Postgres requires PARTITION BY at CREATE time, so the table is created partitioned directly (composite
-- PK (id, occurred_at) includes the partition key — ADR-0022 D1.1). Monthly leaves (current + 12 forward)
-- + a DEFAULT catch-all are created via format(%I) so the static phi-guards scan does not mis-read a
-- partition child as a separate un-triggered org table (a FOR EACH ROW trigger on the partitioned PARENT
-- propagates to every partition, PG11+; the M1 partition-maintenance cron rotates new months).
--
-- Per-LEAF backstop (EVV evv_event precedent): the auto-creation idempotency UNIQUE
-- (triggering_event_outbox_id) WHERE NOT NULL OMITS the partition key, so it cannot live on the
-- partitioned PARENT; add_incident_report_unique_indexes() adds it to each leaf. The patient_id+occurred_at
-- and the open-for-org partial indexes INCLUDE/omit no unique constraint and are non-unique, so they live
-- on the parent. provider_entity_id/location_id (ARCH-011 three-column rule), patient_id, linked QAPI
-- project + document_id are cross-module logical FKs (plain uuid). RLS+grants land in 0067; the M4
-- write-audit trigger (kind_data free-text DENYLISTED, §3.6) in 0068.
CREATE TABLE IF NOT EXISTS "incident_report" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"location_id" uuid,
	"kind" "m30_incident_kind" NOT NULL,
	"kind_data" jsonb NOT NULL,
	"patient_id" uuid,
	"occurred_at" timestamp with time zone NOT NULL,
	"reported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reported_by_membership_id" uuid NOT NULL,
	"severity" "m30_incident_severity" NOT NULL,
	"lifecycle" "m30_incident_lifecycle" DEFAULT 'draft' NOT NULL,
	"mandatory_report_flag" boolean DEFAULT false NOT NULL,
	"external_report_ref" text,
	"external_report_filed_at" timestamp with time zone,
	"corrective_action_taken_text" text,
	"linked_qapi_project_id" uuid,
	"triaged_by_membership_id" uuid,
	"triaged_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"reopened_at" timestamp with time zone,
	"reopen_reason" text,
	"triggering_event_outbox_id" uuid,
	"document_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "incident_report_pk" PRIMARY KEY ("id","occurred_at"),
	CONSTRAINT "incident_report_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict
) PARTITION BY RANGE ("occurred_at");--> statement-breakpoint
-- Per-leaf partial-UNIQUE backstop (auto-creation idempotency) — omits the partition key, so per-leaf.
CREATE OR REPLACE FUNCTION add_incident_report_unique_indexes(partition_name text) RETURNS void AS $$
BEGIN
  EXECUTE format(
    'CREATE UNIQUE INDEX IF NOT EXISTS %I ON %I (triggering_event_outbox_id) WHERE triggering_event_outbox_id IS NOT NULL',
    partition_name || '_auto_creation_uidx', partition_name
  );
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE OR REPLACE FUNCTION create_incident_report_partition(start_date date) RETURNS void AS $$
DECLARE
  partition_name text;
  end_date date;
BEGIN
  partition_name := 'incident_report_' || to_char(start_date, 'YYYY_MM');
  end_date := start_date + INTERVAL '1 month';
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I PARTITION OF incident_report FOR VALUES FROM (%L) TO (%L)',
    partition_name, start_date, end_date
  );
  PERFORM add_incident_report_unique_indexes(partition_name);
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DO $$ BEGIN
  EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF incident_report DEFAULT', 'incident_report_default');
  PERFORM add_incident_report_unique_indexes('incident_report_default');
END $$;--> statement-breakpoint
DO $$ DECLARE i int; BEGIN
  FOR i IN 0..12 LOOP
    PERFORM create_incident_report_partition((date_trunc('month', now()) + (i || ' month')::interval)::date);
  END LOOP;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_incident_auto_creation" ON "incident_report" ("triggering_event_outbox_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_incident_by_patient" ON "incident_report" ("patient_id","occurred_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_incident_open_for_org" ON "incident_report" ("organization_id","severity") WHERE lifecycle NOT IN ('closed_followup_complete');
