-- M24 Billing — Medicaid (WX-PR-011) — `medicaid_state_plan_code` table. PLATFORM-SHARED reference (no
-- organization_id), mirrors the M23 wage_index_factor precedent. Unblocks medicaid_claim.state_plan_code_id
-- (NOT NULL) — see the write-service comment this migration resolves. RLS/grants isolated in 0175 (the
-- wage_index_factor 0078 precedent); M4 write-audit trigger isolated in 0176; seed in 0177.
CREATE TABLE IF NOT EXISTS "medicaid_state_plan_code" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"state_code" text NOT NULL,
	"plan_code" text NOT NULL,
	"plan_name" text NOT NULL,
	"is_state_default" boolean DEFAULT false NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_to" timestamp with time zone,
	"load_source_ref" text NOT NULL,
	"loaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "medicaid_state_plan_code_state_plan_from_uq" UNIQUE("state_code","plan_code","effective_from")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "medicaid_state_plan_code_state_idx" ON "medicaid_state_plan_code" ("state_code");
