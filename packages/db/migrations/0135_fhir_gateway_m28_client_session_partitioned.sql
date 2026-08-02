-- M28 FHIR Gateway §3.3 — `fhir_client_session`, monthly PARTITION BY RANGE (issued_at). In its OWN file
-- because check-ddl-legality rule 1 derives one partition column per FILE and then requires every
-- UNIQUE/PK in that file to include it: the six tables in 0134 are keyed on `id` (or organization_id)
-- alone, this one carries the composite `(jti, issued_at)`. RLS, grants and the M4 write-audit trigger are
-- declared in 0137 on the PARENT and propagate to every partition (PG11+; the M32 ai_invocation /
-- ai_token_ledger precedent).
--
-- TENANT-SCOPED (organization_id NOT NULL, canonical app.org_id RLS in 0137). NO PHI — the JTI, granted
-- scopes and signing-key fingerprint are operational — so the §3.6 denylist is empty and retention is
-- `operational` (90-day purge at the partition level, §3.7). Even so its audit trigger is a GENERATED
-- function (0137) that hard-codes the parent name, because M1's baseline trigger would stamp
-- `TG_TABLE_NAME` = the dated partition (the M32 ai_token_ledger lesson: an empty denylist does NOT mean
-- the baseline trigger is safe on a partitioned table).
--
-- FK POLICY: `client_id` is a LOGICAL uuid — a real FK from this partitioned child to the unpartitioned
-- `fhir_client` would have to name the client's full key, and the write boundary already validates it.
CREATE TABLE IF NOT EXISTS "fhir_client_session" (
	"jti" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"scopes_granted" jsonb NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"ip_at_issue" "inet",
	"token_key_fingerprint" text NOT NULL,
	CONSTRAINT "fhir_client_session_pkey" PRIMARY KEY ("jti","issued_at")
) PARTITION BY RANGE ("issued_at");--> statement-breakpoint
CREATE OR REPLACE FUNCTION create_fhir_client_session_partition(start_date date) RETURNS void AS $$
DECLARE partition_name text; end_date date;
BEGIN
  partition_name := 'fhir_client_session_' || to_char(start_date, 'YYYY_MM');
  end_date := start_date + INTERVAL '1 month';
  EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF fhir_client_session FOR VALUES FROM (%L) TO (%L)', partition_name, start_date, end_date);
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
-- A DEFAULT partition so inserts work the moment the table exists; the M1 partition manager rotates
-- months forward (daily cron, WARDENX_OPS_RUNBOOK §3.4).
DO $$ BEGIN EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF fhir_client_session DEFAULT', 'fhir_client_session_default'); END $$;--> statement-breakpoint
DO $$ DECLARE i int; BEGIN FOR i IN 0..12 LOOP PERFORM create_fhir_client_session_partition((date_trunc('month', now()) + (i || ' month')::interval)::date); END LOOP; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fhir_client_session_client_idx" ON "fhir_client_session" ("client_id","expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fhir_client_session_expiry_idx" ON "fhir_client_session" ("expires_at");
