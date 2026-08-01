-- M32 AI Platform §3.2.9/§3.8 — `ai_token_ledger`, monthly PARTITION BY RANGE (accrued_at). Its own file
-- for the same reason 0114 is: check-ddl-legality derives ONE partition column per file, and this table's
-- key is `accrued_at` while 0114's is `invoked_at`. Putting both in one file would make every PK in it
-- fail the other table's rule. RLS, grants, the M4 write-audit trigger and the §3.5 append-only trigger
-- land in 0116, declared on the PARENT.
--
-- THE MONTH IS THE BILLING PERIOD, which is why the partition boundary and the W2 cap window are the
-- same line: "this tenant's token spend this month" reads exactly one partition, and the hard-cap check
-- that runs before every invocation is a single-partition aggregate rather than a scan of six years of
-- ledger. Retention is 6 years (§3.8) — one year less than `ai_invocation`, because this is the M35 SaaS
-- billing audit trail and not the §164.528 disclosure accounting.
--
-- APPEND-ONLY (§3.5), enforced twice: `wardenx_app` is granted SELECT/INSERT only, and the 0116 trigger
-- refuses UPDATE and DELETE outright. A ledger that can be edited cannot bound anything — the hard cap
-- IS the sum of these rows, and a mutable row makes that sum a claim rather than a total. A correction
-- is a compensating row.
--
-- NO organization-level PHI COLUMNS and no three-column rule: this table holds token counts and dollars.
-- The PHI sits one hop away in `ai_invocation`, and ARCH-011's provider_entity/location pair attaches to
-- PHI-bearing tables.
--
-- `invocation_id` HAS NO FOREIGN KEY, and that is forced rather than chosen: its parent `ai_invocation`
-- is itself partitioned, so a real FK would have to reference the full composite key `(id, invoked_at)`
-- — dragging the invocation's partition key into every ledger row purely to satisfy the constraint, and
-- coupling two independent partition schemes whose boundaries can differ (an invocation started at
-- 23:59 on the 31st accrues on the 1st). Both rows are written in one transaction; the pairing is
-- validated at the write boundary.
--
-- BOTH cost columns are nullable and exactly one is expected per row: `cloud_cost_usd` is real money on
-- a vendor call, `local_compute_attribution` is an internal allocation for a local model. A single
-- "cost" column would make a local run look like spend on the invoice the tenant reads.
CREATE TABLE IF NOT EXISTS "ai_token_ledger" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"invocation_id" uuid NOT NULL,
	"capability_id" uuid NOT NULL,
	"backend_id" uuid NOT NULL,
	"vendor_rate_at_invocation" text,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"cloud_cost_usd" numeric(12, 6),
	"local_compute_attribution" numeric(12, 6),
	"accrued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_token_ledger_pkey" PRIMARY KEY ("id","accrued_at"),
	CONSTRAINT "ai_token_ledger_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "ai_token_ledger_capability_id_fk" FOREIGN KEY ("capability_id") REFERENCES "public"."ai_capability"("id") ON DELETE restrict,
	CONSTRAINT "ai_token_ledger_backend_id_fk" FOREIGN KEY ("backend_id") REFERENCES "public"."ai_model_backend"("id") ON DELETE restrict,
	-- Token counts are counts. A negative accrual would silently refund a tenant against the hard cap.
	CONSTRAINT "ai_token_ledger_nonneg_tokens" CHECK ("input_tokens" >= 0 AND "output_tokens" >= 0)
) PARTITION BY RANGE ("accrued_at");--> statement-breakpoint
CREATE OR REPLACE FUNCTION create_ai_token_ledger_partition(start_date date) RETURNS void AS $$
DECLARE partition_name text; end_date date;
BEGIN
  partition_name := 'ai_token_ledger_' || to_char(start_date, 'YYYY_MM');
  end_date := start_date + INTERVAL '1 month';
  EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF ai_token_ledger FOR VALUES FROM (%L) TO (%L)', partition_name, start_date, end_date);
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DO $$ BEGIN EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF ai_token_ledger DEFAULT', 'ai_token_ledger_default'); END $$;--> statement-breakpoint
DO $$ DECLARE i int; BEGIN FOR i IN 0..12 LOOP PERFORM create_ai_token_ledger_partition((date_trunc('month', now()) + (i || ' month')::interval)::date); END LOOP; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_token_ledger_org_accrued_idx" ON "ai_token_ledger" ("organization_id","accrued_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_token_ledger_cap_accrued_idx" ON "ai_token_ledger" ("organization_id","capability_id","accrued_at" DESC);
