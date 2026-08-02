-- M28 FHIR Gateway §3.3 — `fhir_inbound_resource`, monthly PARTITION BY RANGE (proposed_at). In its OWN
-- file because check-ddl-legality rule 1 derives one partition column per FILE and requires every
-- UNIQUE/PK in that file to include it: this one carries the composite `(id, proposed_at)`. RLS, grants and
-- the M4 write-audit trigger are declared in 0137 on the PARENT and propagate to every partition (PG11+).
--
-- THE STAGED-PROPOSAL LEDGER (D8): an external client POSTs a resource, M28 stages it as a PROPOSAL, and
-- the owner module's reviewer (M5 / M12) accepts or rejects it — M28 never writes a native record itself.
-- `payload` holds the raw FHIR resource, which may carry PHI fragments before acceptance, so §3.6
-- denylists it to `payload_sha256` in the audit value_capture until decision time; the audit trigger is
-- therefore a GENERATED scrubbing function (0137) that hard-codes the parent name (the M32 ai_invocation
-- lesson). Retention is `compliance`: a rejected/expired proposal shreds `payload` at +30 days
-- (`payload_erase_scheduled_at`) while the sha256, decision rationale and audit trail survive; an ACCEPTED
-- proposal keeps its payload (the owner module now owns the native row).
--
-- TENANT-SCOPED (organization_id NOT NULL, canonical app.org_id RLS in 0137). The three-column rule does
-- not attach: the tenancy gate's PHI heuristic (patient_id / observation column) does not fire on the
-- opaque `payload` jsonb. `source_client_id` / `decided_by_membership_id` / `accepted_aggregate_id` are
-- LOGICAL uuids validated at the write boundary.
CREATE TABLE IF NOT EXISTS "fhir_inbound_resource" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"source_client_id" uuid NOT NULL,
	"resource_type" text NOT NULL,
	"source_fhir_id" text,
	"payload" jsonb NOT NULL,
	"payload_sha256" text NOT NULL,
	"proposed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"owner_module" "fhir_inbound_owner_module" NOT NULL,
	"proposal_status" "fhir_inbound_status" DEFAULT 'pending' NOT NULL,
	"decided_by_membership_id" uuid,
	"decided_at" timestamp with time zone,
	"decision_rationale" text,
	"accepted_aggregate_id" uuid,
	"validation_errors" jsonb,
	"payload_erase_scheduled_at" timestamp with time zone,
	CONSTRAINT "fhir_inbound_resource_pkey" PRIMARY KEY ("id","proposed_at")
) PARTITION BY RANGE ("proposed_at");--> statement-breakpoint
CREATE OR REPLACE FUNCTION create_fhir_inbound_resource_partition(start_date date) RETURNS void AS $$
DECLARE partition_name text; end_date date;
BEGIN
  partition_name := 'fhir_inbound_resource_' || to_char(start_date, 'YYYY_MM');
  end_date := start_date + INTERVAL '1 month';
  EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF fhir_inbound_resource FOR VALUES FROM (%L) TO (%L)', partition_name, start_date, end_date);
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
-- A DEFAULT partition so inserts work the moment the table exists; the M1 partition manager rotates
-- months forward (daily cron, WARDENX_OPS_RUNBOOK §3.4).
DO $$ BEGIN EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF fhir_inbound_resource DEFAULT', 'fhir_inbound_resource_default'); END $$;--> statement-breakpoint
DO $$ DECLARE i int; BEGIN FOR i IN 0..12 LOOP PERFORM create_fhir_inbound_resource_partition((date_trunc('month', now()) + (i || ' month')::interval)::date); END LOOP; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fhir_inbound_org_idx" ON "fhir_inbound_resource" ("organization_id","proposal_status","proposed_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fhir_inbound_owner_idx" ON "fhir_inbound_resource" ("owner_module","proposal_status") WHERE proposal_status = 'pending';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fhir_inbound_dedup_idx" ON "fhir_inbound_resource" ("source_client_id","resource_type","source_fhir_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fhir_inbound_erase_idx" ON "fhir_inbound_resource" ("payload_erase_scheduled_at") WHERE proposal_status IN ('rejected','expired');
