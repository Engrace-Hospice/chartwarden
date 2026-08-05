-- M24 Billing — Medicaid (WX-PR-011 line-assembly follow-up) — `medicaid_state_rate_schedule` table.
-- PLATFORM-SHARED reference (no organization_id), mirrors medicaid_state_plan_code (0174). Feeds the
-- RHC/CHC/IRC/GIP claim-line rate resolution; NF_RB is EXCLUDED by CHECK (audit finding M24-F02 — R&B
-- prices off rb_arrangement/rb_day, never a per-county schedule). RLS/grants isolated in 0180; M4
-- write-audit trigger isolated in 0181; seed in 0182.
CREATE TABLE IF NOT EXISTS "medicaid_state_rate_schedule" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"state_code" text NOT NULL,
	"level_of_care" "m24_claim_line_loc" NOT NULL,
	"county_code" text,
	"rate_cents" integer NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_to" timestamp with time zone,
	"load_source_ref" text NOT NULL,
	"loaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "medicaid_state_rate_schedule_uq" UNIQUE("state_code","level_of_care","county_code","effective_from"),
	CONSTRAINT "medicaid_state_rate_schedule_rate_positive" CHECK ("rate_cents" > 0),
	CONSTRAINT "medicaid_state_rate_schedule_no_rb" CHECK ("level_of_care" <> 'NF_RB')
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "medicaid_state_rate_schedule_state_loc_idx" ON "medicaid_state_rate_schedule" ("state_code","level_of_care");
