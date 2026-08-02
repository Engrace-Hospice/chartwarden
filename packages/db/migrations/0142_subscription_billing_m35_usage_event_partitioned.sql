-- M35 Subscription Billing §3.3 — `usage_event`, monthly PARTITION BY RANGE (recorded_at). In its OWN
-- file because check-ddl-legality rule 1 derives one partition column per FILE and then requires every
-- UNIQUE/PK in that file to include it: the eleven tables in 0141 are keyed on `id` (or Stripe natural
-- keys) alone, this one carries the composite PK `(id, recorded_at)` and the composite dedup unique
-- `(organization_id, source_module, source_event_id, recorded_at)`. RLS, grants and the M4 write-audit
-- trigger are declared in 0143 on the PARENT and propagate to every partition (PG11+; the M32
-- ai_invocation / ai_token_ledger + M28 fhir_client_session precedent).
--
-- TENANT-SCOPED (organization_id NOT NULL, canonical app.org_id RLS in 0143). NO PHI — high-volume
-- append-only metering; §3.6 requests full audit exclusion but the trigger is still a GENERATED function
-- (0143) that hard-codes the parent name, because M1's baseline trigger would stamp `TG_TABLE_NAME` = the
-- dated partition (the M32 ai_token_ledger lesson: an empty/exclusion denylist does NOT make the baseline
-- trigger safe on a partitioned table). Retention is `operational`.
--
-- FK POLICY (M35-F04): organization_id + subscription_id are LOGICAL uuids (a real FK from this
-- partitioned child to the unpartitioned `subscription` would force it to name the parent's full key; the
-- ingest boundary validates them). `metadata_redacted` is PHI-free (redactor-checked, W-SB-08).
CREATE TABLE IF NOT EXISTS "usage_event" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"subscription_id" uuid,
	"event_type" "usage_event_type" NOT NULL,
	"quantity" bigint NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_module" "usage_event_source_module" NOT NULL,
	"source_event_id" text,
	"metadata_redacted" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "usage_event_pkey" PRIMARY KEY ("id","recorded_at")
) PARTITION BY RANGE ("recorded_at");--> statement-breakpoint
CREATE OR REPLACE FUNCTION create_usage_event_partition(start_date date) RETURNS void AS $$
DECLARE partition_name text; end_date date;
BEGIN
  partition_name := 'usage_event_' || to_char(start_date, 'YYYY_MM');
  end_date := start_date + INTERVAL '1 month';
  EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF usage_event FOR VALUES FROM (%L) TO (%L)', partition_name, start_date, end_date);
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
-- A DEFAULT partition so inserts work the moment the table exists; the M1 partition manager rotates
-- months forward (daily cron, WARDENX_OPS_RUNBOOK §3.4).
DO $$ BEGIN EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF usage_event DEFAULT', 'usage_event_default'); END $$;--> statement-breakpoint
DO $$ DECLARE i int; BEGIN FOR i IN 0..12 LOOP PERFORM create_usage_event_partition((date_trunc('month', now()) + (i || ' month')::interval)::date); END LOOP; END $$;--> statement-breakpoint
-- The §3.4 dedup unique includes the partition key (recorded_at), as PostgreSQL requires.
CREATE UNIQUE INDEX IF NOT EXISTS "usage_event_source_dedup_uq" ON "usage_event" ("organization_id","source_module","source_event_id","recorded_at") WHERE source_event_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "usage_event_org_recorded_ix" ON "usage_event" ("organization_id","recorded_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "usage_event_event_type_ix" ON "usage_event" ("event_type","recorded_at");
