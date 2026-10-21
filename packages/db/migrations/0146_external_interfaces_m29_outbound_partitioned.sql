-- M29 External Interfaces §3.3 — hl7_message_outbound, monthly PARTITION BY RANGE (queued_at). In its own
-- file (check-ddl-legality rule 1: one partition column per file; every PK/UNIQUE must include it — the
-- composite PK is (id, queued_at)). RLS, grants and the M4 write-audit trigger are on the PARTITIONED
-- PARENT in 0148 and propagate to every partition.
--
-- PARTITION-KEY DEVIATION (architecture / PostgreSQL wins over §3.2/§3.3). The spec partitions on
-- `transmitted_at`, but that column is NULL while a message sits `queued` — and a partition key that is
-- part of the PRIMARY KEY must be NOT NULL. So the partition key is `queued_at` (NOT NULL defaultNow,
-- always present at insert); `transmitted_at` stays a nullable data column. `M29_PARTITIONED_TABLES` in
-- @chartwarden/types names `queued_at` to keep the one source of truth honest.
--
-- TENANT-SCOPED (organization_id NOT NULL, canonical app.org_id RLS in 0148). §3.6 denylists payload_cipher
-- + ack_payload_cipher (kept as *_sha256 digests). FK POLICY: organization_id / feed_id /
-- source_aggregate_id / destination_facility_id are LOGICAL uuids validated at the write boundary.
CREATE TABLE IF NOT EXISTS "hl7_message_outbound" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"feed_id" uuid NOT NULL,
	"message_type" text NOT NULL,
	"message_control_id" text NOT NULL,
	"payload_cipher" text NOT NULL,
	"payload_sha256" text NOT NULL,
	"segments_summary" jsonb NOT NULL,
	"source_aggregate_kind" text NOT NULL,
	"source_aggregate_id" uuid NOT NULL,
	"destination_facility_id" uuid,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"transmitted_at" timestamp with time zone,
	"ack_status" "hl7_outbound_ack_status",
	"ack_received_at" timestamp with time zone,
	"ack_payload_cipher" text,
	"ack_payload_sha256" text,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"next_retry_at" timestamp with time zone,
	"status" "hl7_outbound_status" DEFAULT 'queued' NOT NULL,
	"idempotency_key" text NOT NULL,
	CONSTRAINT "hl7_message_outbound_pkey" PRIMARY KEY ("id","queued_at")
) PARTITION BY RANGE ("queued_at");--> statement-breakpoint
CREATE OR REPLACE FUNCTION create_hl7_message_outbound_partition(start_date date) RETURNS void AS $$
DECLARE partition_name text; end_date date;
BEGIN
  partition_name := 'hl7_message_outbound_' || to_char(start_date, 'YYYY_MM');
  end_date := start_date + INTERVAL '1 month';
  EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF hl7_message_outbound FOR VALUES FROM (%L) TO (%L)', partition_name, start_date, end_date);
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DO $$ BEGIN EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF hl7_message_outbound DEFAULT', 'hl7_message_outbound_default'); END $$;--> statement-breakpoint
DO $$ DECLARE i int; BEGIN FOR i IN 0..12 LOOP PERFORM create_hl7_message_outbound_partition((date_trunc('month', now()) + (i || ' month')::interval)::date); END LOOP; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_hmo_org_feed" ON "hl7_message_outbound" ("organization_id","feed_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_hmo_status" ON "hl7_message_outbound" ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_hmo_idempotency" ON "hl7_message_outbound" ("idempotency_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_hmo_next_retry" ON "hl7_message_outbound" ("status","next_retry_at") WHERE status IN ('queued','naked');
