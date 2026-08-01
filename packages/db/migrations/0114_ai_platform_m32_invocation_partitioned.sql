-- M32 AI Platform §3.2.8/§3.8 — `ai_invocation`, monthly PARTITION BY RANGE (invoked_at). In its OWN
-- file because check-ddl-legality rule 1 derives one partition column per FILE and then requires every
-- UNIQUE/PK in that file to include it: the eleven tables in 0113 are keyed on `id` alone, this one
-- carries the composite `(id, invoked_at)`. RLS, grants, the M4 write-audit trigger and the §3.5
-- column-immutability trigger are declared in 0116 on the PARENT and propagate to every partition
-- (PG11+; the M16 contact-log / M21 supply-request / M25 / M30 precedent).
--
-- THIS TABLE IS THE §164.528 DISCLOSURE LEDGER, and every unusual thing about it follows from that:
--
--   • A REFUSED CALL IS A ROW. `status = 'capability_unavailable'` is a recorded outcome, not an absent
--     row, because when a patient asks whether their chart went to a model vendor the answer "no" has to
--     be provable — and only a written row proves a negative. The same logic makes `killed` and
--     `timed_out` first-class statuses rather than error logs.
--   • §3.7's ERASER DELETES NOTHING. Destruction is a cryptographic shred of the per-tenant DEK: the
--     row survives with its token counts, model pin, ZDR flag and timestamps intact — those ARE the
--     accounting evidence — while the three cipher payloads become unreadable. Deleting the rows would
--     destroy the record THAT the disclosure happened, which is the opposite of what a destruction
--     certificate is for. Hence `wardenx_app` gets no DELETE privilege and the 0116 trigger refuses one.
--   • RETENTION IS 7 YEARS at the partition level (§3.8) — the §164.528 right-to-an-accounting window
--     plus the HIPAA audit-control floor, one year longer than `ai_token_ledger`.
--
-- THE THREE-COLUMN RULE (ARCH-011, which wins over §3.2.8's two columns): provider_entity_id NOT NULL +
-- location_id nullable. NOT NULL on the provider entity is deliberate pressure on the T04 pipeline: a
-- disclosure accounting must name WHICH certified provider entity disclosed the PHI — "the tenant" is not
-- an answer a surveyor accepts — and a nullable column would let the pipeline ship without ever resolving
-- it. Location stays nullable because an invocation happens wherever the clinician is, which is
-- frequently not a Location the org has on file.
--
-- WHY THE COMPOSITE PK IS NOT A PROBLEM HERE (contrast M19, which refused partitioning for exactly this
-- reason): `ai_invocation` has no natural-key uniqueness rule at all. Nothing in §3.2.8 says "one
-- invocation per X" — a retry IS a new invocation and must be a new row — so dragging `invoked_at` into
-- the key costs nothing, while the volume argument is real (every capability call, refusals included,
-- for every tenant, kept seven years).
--
-- FK POLICY: organization / provider_entity / location (M1 spine) and `ai_capability` /
-- `ai_model_backend` (platform-shared, unpartitioned) carry REAL FKs — a partitioned child may reference
-- an unpartitioned parent. `actor_membership_id` (M2), `patient_id` (M5), `prompt_template_id` and
-- `consumer_correlation_id` are LOGICAL uuid, validated at the write boundary.
CREATE TABLE IF NOT EXISTS "ai_invocation" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"location_id" uuid,
	"capability_id" uuid NOT NULL,
	"capability_key" text NOT NULL,
	"prompt_template_id" uuid,
	"prompt_template_version" text,
	"backend_id" uuid NOT NULL,
	"backend_key" text NOT NULL,
	"model_version_pin" text NOT NULL,
	"actor_membership_id" uuid NOT NULL,
	"actor_role" text NOT NULL,
	"patient_id" uuid,
	"consumer_correlation_id" uuid,
	"consumer_context_ref" jsonb NOT NULL,
	"routing_decision" "ai_routing_decision" NOT NULL,
	"routing_reason" "ai_routing_reason" NOT NULL,
	"prompt_payload_cipher" bytea NOT NULL,
	"response_payload_cipher" bytea,
	"chart_context_cipher" bytea,
	"input_token_count" integer NOT NULL,
	"output_token_count" integer DEFAULT 0 NOT NULL,
	"duration_ms" integer DEFAULT 0 NOT NULL,
	"status" "ai_invocation_status" NOT NULL,
	"error_class" text,
	"error_message" text,
	"hitl_outcome" "ai_invocation_hitl_outcome" DEFAULT 'pending' NOT NULL,
	"zdr_confirmed" boolean NOT NULL,
	"invoked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_invocation_pkey" PRIMARY KEY ("id","invoked_at"),
	CONSTRAINT "ai_invocation_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "ai_invocation_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict,
	CONSTRAINT "ai_invocation_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict,
	CONSTRAINT "ai_invocation_capability_id_fk" FOREIGN KEY ("capability_id") REFERENCES "public"."ai_capability"("id") ON DELETE restrict,
	CONSTRAINT "ai_invocation_backend_id_fk" FOREIGN KEY ("backend_id") REFERENCES "public"."ai_model_backend"("id") ON DELETE restrict,
	-- D19 at the ROW level. The registry's `ai_backend_cloud_baa_check` guards REGISTRATION; this guards
	-- the individual call, so a backend whose ZDR status was flipped after registration cannot leave
	-- unmarked Anthropic-routed rows behind it.
	CONSTRAINT "ai_invocation_zdr_check" CHECK ("zdr_confirmed" = true OR "backend_key" NOT LIKE 'anthropic-%')
) PARTITION BY RANGE ("invoked_at");--> statement-breakpoint
CREATE OR REPLACE FUNCTION create_ai_invocation_partition(start_date date) RETURNS void AS $$
DECLARE partition_name text; end_date date;
BEGIN
  partition_name := 'ai_invocation_' || to_char(start_date, 'YYYY_MM');
  end_date := start_date + INTERVAL '1 month';
  EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF ai_invocation FOR VALUES FROM (%L) TO (%L)', partition_name, start_date, end_date);
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
-- A DEFAULT partition so inserts work the moment the table exists; the M1 partition manager rotates
-- months forward (daily cron, WARDENX_OPS_RUNBOOK §3.4).
DO $$ BEGIN EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF ai_invocation DEFAULT', 'ai_invocation_default'); END $$;--> statement-breakpoint
DO $$ DECLARE i int; BEGIN FOR i IN 0..12 LOOP PERFORM create_ai_invocation_partition((date_trunc('month', now()) + (i || ' month')::interval)::date); END LOOP; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_invocation_org_invoked_idx" ON "ai_invocation" ("organization_id","invoked_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_invocation_capability_invoked_idx" ON "ai_invocation" ("capability_key","invoked_at" DESC);--> statement-breakpoint
-- The accounting-of-disclosures lookup. Partial: an invocation with no patient is part of nobody's
-- accounting, and excluding those keeps the index to the rows the request actually reads.
CREATE INDEX IF NOT EXISTS "ai_invocation_patient_invoked_idx" ON "ai_invocation" ("patient_id","invoked_at" DESC) WHERE patient_id IS NOT NULL;
