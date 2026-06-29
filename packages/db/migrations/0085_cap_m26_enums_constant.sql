-- M26 Cap Management §3.2 Phase 1+2 — the 13 `m26_*` ENUM types + the single PLATFORM-scoped
-- cap_period_platform_constant table (no organization_id; the CMS-published per-cap-year amount, D3). The
-- eleven org-scoped tenant tables land in 0086 (non-partitioned) + 0087 (the three LIST(cap_period_id)
-- partitioned tables); tenant RLS in 0088; platform-constant RLS in 0089 (isolated, the 0078 wage-index
-- precedent); M4 write-audit + append-only revokes in 0090; the platform-constant seed in 0091.
--
-- CONVENTIONS (mirror M23 0074 / M25 0081 / M27 0069 / M30): enum types are `m26_`-prefixed (anti-collision,
-- check-ddl-legality rule 3 — one CREATE TYPE pairs 1:1 with the pgEnum in src/schema/cap/enums.ts). Money
-- is BIGINT cents (never NUMERIC/FLOAT). cap_period_platform_constant has NO organization_id BY DESIGN
-- (NON_ORG_SCOPED allowlist; read-all + platform-only write).

-- ============================================================================================
-- Phase 1 — enums (13)
-- ============================================================================================
CREATE TYPE "public"."m26_period_status" AS ENUM('open', 'active', 'in_settlement', 'settled', 'reopened');--> statement-breakpoint
CREATE TYPE "public"."m26_methodology" AS ENUM('streamlined', 'proportional');--> statement-breakpoint
CREATE TYPE "public"."m26_line_source_kind" AS ENUM('remittance', 'adjustment', 'reversal', 'manual_correction');--> statement-breakpoint
CREATE TYPE "public"."m26_inpatient_source_kind" AS ENUM('claim_line');--> statement-breakpoint
CREATE TYPE "public"."m26_projection_scope" AS ENUM('agency_aggregate', 'patient_aggregate', 'inpatient');--> statement-breakpoint
CREATE TYPE "public"."m26_projection_trigger" AS ENUM('nightly_batch', 'remittance_trigger', 'manual_recompute');--> statement-breakpoint
CREATE TYPE "public"."m26_alert_band" AS ENUM('safe', 'watch_90', 'warn_95', 'breach_100', 'inpatient_safe', 'inpatient_watch_18', 'inpatient_breach_20');--> statement-breakpoint
CREATE TYPE "public"."m26_settlement_status" AS ENUM('proposed', 'reviewed', 'final');--> statement-breakpoint
CREATE TYPE "public"."m26_psr_parse_status" AS ENUM('queued', 'parsed', 'parse_failed', 'reconciled');--> statement-breakpoint
CREATE TYPE "public"."m26_psr_recon_scope" AS ENUM('beneficiary', 'agency_aggregate', 'inpatient');--> statement-breakpoint
CREATE TYPE "public"."m26_psr_recon_status" AS ENUM('open', 'investigating', 'resolved', 'accepted');--> statement-breakpoint
CREATE TYPE "public"."m26_psr_variance_reason" AS ENUM('timing', 'psr_correction', 'our_correction', 'mbi_mismatch', 'data_quality', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."m26_mac_region" AS ENUM('ngs', 'cgs', 'palmetto', 'wps', 'noridian', 'first_coast', 'novitas');--> statement-breakpoint

-- ============================================================================================
-- Phase 2 — cap_period_platform_constant (PLATFORM-scoped; one row per cap year)
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "cap_period_platform_constant" (
	"cap_year" varchar(7) NOT NULL,
	"aggregate_cap_amount_cents" bigint,
	"inpatient_cap_pct" numeric(5, 4) DEFAULT '0.2000' NOT NULL,
	"source_url" text,
	"source_published_at" timestamp with time zone,
	"recorded_by" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"first_tenant_use_at" timestamp with time zone,
	CONSTRAINT "cap_period_platform_constant_pk" PRIMARY KEY ("cap_year"),
	CONSTRAINT "cap_platform_constant_year_fmt_ck" CHECK ("cap_year" ~ '^FY[0-9]{4}$'),
	CONSTRAINT "cap_platform_constant_pct_ck" CHECK ("inpatient_cap_pct" >= 0 AND "inpatient_cap_pct" <= 1)
);
