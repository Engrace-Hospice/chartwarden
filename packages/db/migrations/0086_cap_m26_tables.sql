-- M26 Cap Management §3.2 Phase 3 — the eight NON-partitioned org-scoped tenant tables: the cap_period
-- lifecycle root (+ its no-overlap EXCLUDE via btree_gist), the methodology lock, the two accrual
-- roll-ups, the threshold-event queue, and the PS&R import/reconciliation + settlement cluster. The three
-- LIST(cap_period_id)-partitioned line/snapshot tables land in 0087; RLS/grants 0088; platform-constant
-- RLS 0089; M4 write-audit 0090.
--
-- CROSS-MODULE FK POLICY (architecture WINS): only organization_id → organization and intra-M26
-- non-partitioned parents (cap_period, cap_psr_import) are real FKs. patient_id (M5), *_by /
-- step_up_session_id (M2), source ids (M23/M25), cap_year (soft → cap_period_platform_constant) are
-- LOGICAL uuid. Money is BIGINT cents; percentages numeric(7,4) / numeric(5,4).

CREATE EXTENSION IF NOT EXISTS btree_gist;--> statement-breakpoint

-- ============================================================================================
-- cap_period — per-tenant, per-cap-year lifecycle root
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "cap_period" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"ccn" char(6) NOT NULL,
	"cap_year" varchar(7) NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	"aggregate_cap_amount_cents" bigint NOT NULL,
	"inpatient_cap_pct" numeric(5, 4) NOT NULL,
	"methodology" "m26_methodology",
	"status" "m26_period_status" DEFAULT 'open' NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"opened_by" uuid NOT NULL,
	"closed_at" timestamp with time zone,
	"closed_by" uuid,
	"settled_at" timestamp with time zone,
	"settled_by" uuid,
	"grace_window_days" smallint DEFAULT 30 NOT NULL,
	"notes" text,
	CONSTRAINT "cap_period_pk" PRIMARY KEY ("id"),
	CONSTRAINT "cap_period_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "cap_period_org_ccn_year_uq" UNIQUE ("organization_id", "ccn", "cap_year"),
	CONSTRAINT "cap_period_window_ck" CHECK ("ends_on" > "starts_on"),
	CONSTRAINT "cap_period_grace_ck" CHECK ("grace_window_days" BETWEEN 0 AND 90),
	CONSTRAINT "cap_period_year_fmt_ck" CHECK ("cap_year" ~ '^FY[0-9]{4}$'),
	CONSTRAINT "cap_period_no_overlap" EXCLUDE USING gist ("organization_id" WITH =, "ccn" WITH =, daterange("starts_on", "ends_on", '[]') WITH &&)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cap_period_status_active_ix" ON "cap_period" ("organization_id", "status") WHERE status = 'active';--> statement-breakpoint

-- ============================================================================================
-- cap_period_methodology_lock — 1:1 with cap_period (one-time, step-up-gated)
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "cap_period_methodology_lock" (
	"cap_period_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"methodology" "m26_methodology" NOT NULL,
	"locked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_by" uuid NOT NULL,
	"reason" text NOT NULL,
	"step_up_session_id" uuid NOT NULL,
	CONSTRAINT "cap_period_methodology_lock_pk" PRIMARY KEY ("cap_period_id"),
	CONSTRAINT "cap_methodology_lock_period_fk" FOREIGN KEY ("cap_period_id") REFERENCES "public"."cap_period"("id") ON DELETE cascade,
	CONSTRAINT "cap_methodology_lock_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict
);--> statement-breakpoint

-- ============================================================================================
-- cap_beneficiary_accrual — one row per (org, period, patient); paid-to-date roll-up
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "cap_beneficiary_accrual" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"cap_period_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"mbi_normalized" text NOT NULL,
	"paid_cents" bigint DEFAULT 0 NOT NULL,
	"outstanding_billed_cents" bigint DEFAULT 0 NOT NULL,
	"methodology_weight" numeric(7, 6) DEFAULT '1.000000' NOT NULL,
	"first_election_in_period" date NOT NULL,
	"last_paid_through" date,
	"deceased_at" date,
	"last_updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cap_beneficiary_accrual_pk" PRIMARY KEY ("id"),
	CONSTRAINT "cap_ben_accrual_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "cap_ben_accrual_period_fk" FOREIGN KEY ("cap_period_id") REFERENCES "public"."cap_period"("id") ON DELETE restrict,
	CONSTRAINT "cap_ben_accrual_period_patient_uq" UNIQUE ("organization_id", "cap_period_id", "patient_id")
);--> statement-breakpoint

-- ============================================================================================
-- cap_inpatient_accrual — one row per (org, period); GIP+IRC days over the 20% denominator
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "cap_inpatient_accrual" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"cap_period_id" uuid NOT NULL,
	"gip_days" integer DEFAULT 0 NOT NULL,
	"irc_days" integer DEFAULT 0 NOT NULL,
	"total_patient_days" integer DEFAULT 0 NOT NULL,
	"inpatient_pct" numeric(7, 4) DEFAULT '0.0000' NOT NULL,
	"last_updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cap_inpatient_accrual_pk" PRIMARY KEY ("id"),
	CONSTRAINT "cap_inp_accrual_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "cap_inp_accrual_period_fk" FOREIGN KEY ("cap_period_id") REFERENCES "public"."cap_period"("id") ON DELETE restrict,
	CONSTRAINT "cap_inpatient_accrual_uq" UNIQUE ("organization_id", "cap_period_id")
);--> statement-breakpoint

-- ============================================================================================
-- cap_threshold_event — band-transition queue (acknowledge / resolve)
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "cap_threshold_event" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"cap_period_id" uuid NOT NULL,
	"scope" "m26_projection_scope" NOT NULL,
	"patient_id" uuid,
	"prior_band" "m26_alert_band" NOT NULL,
	"current_band" "m26_alert_band" NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"raised_at" timestamp with time zone DEFAULT now() NOT NULL,
	"acknowledged_by" uuid,
	"acknowledged_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"notes" text,
	CONSTRAINT "cap_threshold_event_pk" PRIMARY KEY ("id"),
	CONSTRAINT "cap_threshold_event_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "cap_threshold_event_period_fk" FOREIGN KEY ("cap_period_id") REFERENCES "public"."cap_period"("id") ON DELETE restrict,
	CONSTRAINT "cap_threshold_event_uq" UNIQUE ("cap_period_id", "scope", "patient_id", "prior_band", "current_band", "snapshot_id")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cap_threshold_event_open_ix" ON "cap_threshold_event" ("organization_id", "acknowledged_at", "resolved_at");--> statement-breakpoint

-- ============================================================================================
-- cap_psr_import — one row per uploaded MAC PS&R CSV (dedupe by file_sha256 within org+period)
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "cap_psr_import" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"cap_period_id" uuid NOT NULL,
	"mac_region" "m26_mac_region" NOT NULL,
	"psr_period_from" date NOT NULL,
	"psr_period_to" date NOT NULL,
	"file_storage_key" text NOT NULL,
	"file_sha256" char(64) NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"imported_by" uuid NOT NULL,
	"parse_status" "m26_psr_parse_status" DEFAULT 'queued' NOT NULL,
	"parse_error" text,
	"beneficiary_count_psr" integer,
	"paid_total_cents_psr" bigint,
	"inpatient_days_psr" integer,
	CONSTRAINT "cap_psr_import_pk" PRIMARY KEY ("id"),
	CONSTRAINT "cap_psr_import_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "cap_psr_import_period_fk" FOREIGN KEY ("cap_period_id") REFERENCES "public"."cap_period"("id") ON DELETE restrict,
	CONSTRAINT "cap_psr_import_file_uq" UNIQUE ("organization_id", "cap_period_id", "file_sha256")
);--> statement-breakpoint

-- ============================================================================================
-- cap_psr_reconciliation — per-line variance (M26 ledger vs MAC PS&R figure)
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "cap_psr_reconciliation" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"cap_period_id" uuid NOT NULL,
	"psr_import_id" uuid NOT NULL,
	"scope" "m26_psr_recon_scope" NOT NULL,
	"patient_id" uuid,
	"m26_accrual_cents" bigint,
	"m26_inpatient_days" integer,
	"psr_amount_cents" bigint,
	"psr_inpatient_days" integer,
	"variance_cents" bigint,
	"variance_days" integer,
	"variance_reason" "m26_psr_variance_reason",
	"status" "m26_psr_recon_status" DEFAULT 'open' NOT NULL,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"resolution_notes" text,
	"raised_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cap_psr_reconciliation_pk" PRIMARY KEY ("id"),
	CONSTRAINT "cap_psr_recon_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "cap_psr_recon_period_fk" FOREIGN KEY ("cap_period_id") REFERENCES "public"."cap_period"("id") ON DELETE restrict,
	CONSTRAINT "cap_psr_recon_import_fk" FOREIGN KEY ("psr_import_id") REFERENCES "public"."cap_psr_import"("id") ON DELETE cascade
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cap_psr_reconciliation_open_ix" ON "cap_psr_reconciliation" ("organization_id", "status", "raised_at") WHERE status IN ('open', 'investigating');--> statement-breakpoint

-- ============================================================================================
-- cap_settlement — one row per cap_period; the year-close settlement worksheet
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "cap_settlement" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"cap_period_id" uuid NOT NULL,
	"paid_total_cents" bigint NOT NULL,
	"beneficiary_count" integer NOT NULL,
	"aggregate_cap_amount_cents" bigint NOT NULL,
	"aggregate_overage_cents" bigint NOT NULL,
	"inpatient_total_days" integer NOT NULL,
	"inpatient_overage_days" integer NOT NULL,
	"inpatient_overage_cents" bigint NOT NULL,
	"status" "m26_settlement_status" DEFAULT 'proposed' NOT NULL,
	"proposed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"proposed_by" uuid NOT NULL,
	"finalized_at" timestamp with time zone,
	"finalized_by" uuid,
	"step_up_session_id" uuid,
	"notes" text,
	CONSTRAINT "cap_settlement_pk" PRIMARY KEY ("id"),
	CONSTRAINT "cap_settlement_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "cap_settlement_period_fk" FOREIGN KEY ("cap_period_id") REFERENCES "public"."cap_period"("id") ON DELETE restrict,
	CONSTRAINT "cap_settlement_period_uq" UNIQUE ("cap_period_id")
);
