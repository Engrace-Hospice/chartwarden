-- M29 External Interfaces §3.2/§3.3 — the 23 enum types (Phase A) and SIX of the module's eleven owned
-- tables (Phase B, the UNPARTITIONED set; Phase E indexes inline). The five partitioned tables land in
-- 0145 (hl7_message_inbound / lab_observation / lab_observation_value, all on received_at), 0146
-- (hl7_message_outbound on queued_at) and 0147 (hl7_inbound_proposal on proposed_at) — each grouped by a
-- SINGLE partition column per file, because check-ddl-legality rule 1 derives one partition column per FILE
-- and then requires every PK/UNIQUE in it to include that column. RLS, grants and the M4 write-audit
-- triggers land in 0148.
--
-- TENANCY (ARCH-011 / ADR-0010), the shape of the module:
--   • FOUR TENANT-SCOPED tables here carry organization_id on canonical app.org_id RLS (0148):
--     external_feed, external_feed_credential (REAL org FK), external_feed_health (composite PK
--     (feed_id, hour_bucket) — no synthetic id), lab_observation_inbound_link (REAL org FK; its
--     observation_id / source_message_id reference PARTITIONED parents so stay LOGICAL uuids).
--   • TWO PLATFORM-SHARED tables: nppes_provider (keyed by the 10-char NPI) + nppes_sync_run carry NO
--     organization_id BY DESIGN — the CMS NPPES directory is the same for every tenant. Read-all
--     `USING (true)` TO wardenx_app, writes only via wardenx_admin (0148; the M28 fhir_capability_snapshot
--     / M38 code_system precedent). Both listed in check-tenancy.ts's NON_ORG_SCOPED set.
--
-- FK POLICY (architecture §25.15): organization (M1 spine) and the intra-M29 parent external_feed carry
-- REAL FKs. Every cross-module reference (M40 facility ids, M2 membership ids, the app-side refs into the
-- partitioned tables) is a LOGICAL uuid validated at the write boundary — no DB FK crosses a module edge.

-- ============================================================================================
-- §3.2 Phase A — the 23 enum types.
-- ============================================================================================
CREATE TYPE "public"."external_feed_kind" AS ENUM('adt_inbound', 'lab_inbound', 'orm_outbound');--> statement-breakpoint
CREATE TYPE "public"."external_feed_protocol" AS ENUM('mllp_tls', 'mllp_plain');--> statement-breakpoint
CREATE TYPE "public"."external_feed_status" AS ENUM('proposed', 'pending_approval', 'active', 'suspended', 'revoked', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."external_feed_credential_kind" AS ENUM('mllp_client_cert', 'mllp_channel_password');--> statement-breakpoint
CREATE TYPE "public"."external_feed_credential_status" AS ENUM('active', 'retired');--> statement-breakpoint
CREATE TYPE "public"."hl7_inbound_parse_status" AS ENUM('in_progress', 'parsed', 'parse_error', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."hl7_inbound_proposal_kind" AS ENUM('patient_demographic_update', 'admission_event', 'discharge_event', 'cancel_admission', 'new_patient');--> statement-breakpoint
CREATE TYPE "public"."hl7_inbound_proposal_status" AS ENUM('pending', 'accepted', 'rejected', 'expired');--> statement-breakpoint
CREATE TYPE "public"."hl7_inbound_match_outcome" AS ENUM('matched_single', 'matched_ambiguous', 'no_match', 'merged_target');--> statement-breakpoint
CREATE TYPE "public"."hl7_inbound_match_level" AS ENUM('L1_MRN_EXACT', 'L2_EXTERNAL_MRN_EXACT', 'L3_SSN_DOB', 'L4_DEMOGRAPHIC_BRIDGE_CANDIDATE', 'L5_LOOSE_NAME_DOB_CANDIDATE', 'NO_MATCH');--> statement-breakpoint
CREATE TYPE "public"."hl7_outbound_ack_status" AS ENUM('aa', 'ae', 'ar', 'timeout');--> statement-breakpoint
CREATE TYPE "public"."hl7_outbound_status" AS ENUM('queued', 'in_flight', 'acked', 'naked', 'failed', 'dlq');--> statement-breakpoint
CREATE TYPE "public"."lab_result_status" AS ENUM('preliminary', 'final', 'corrected', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."lab_abnormal_summary" AS ENUM('any_critical', 'any_abnormal', 'all_normal', 'no_flags');--> statement-breakpoint
CREATE TYPE "public"."lab_abnormal_flag" AS ENUM('H', 'L', 'HH', 'LL', 'A', 'N');--> statement-breakpoint
CREATE TYPE "public"."lab_value_type" AS ENUM('NM', 'ST', 'CE', 'SN', 'TX', 'DT');--> statement-breakpoint
CREATE TYPE "public"."lab_terminology_validation" AS ENUM('valid', 'unknown_code', 'deprecated');--> statement-breakpoint
CREATE TYPE "public"."lab_match_method" AS ENUM('obr_placer_id', 'patient_loinc_date', 'manual', 'unmatched');--> statement-breakpoint
CREATE TYPE "public"."nppes_enumeration_type" AS ENUM('NPI-1', 'NPI-2');--> statement-breakpoint
CREATE TYPE "public"."nppes_provider_status" AS ENUM('active', 'deactivated');--> statement-breakpoint
CREATE TYPE "public"."nppes_sync_kind" AS ENUM('daily_incremental', 'weekly_dissemination', 'monthly_deactivation', 'manual');--> statement-breakpoint
CREATE TYPE "public"."nppes_sync_trigger" AS ENUM('platform_cron', 'platform_admin');--> statement-breakpoint
CREATE TYPE "public"."nppes_sync_status" AS ENUM('in_progress', 'completed', 'failed');--> statement-breakpoint

-- ============================================================================================
-- §3.3 external_feed — the per-tenant HL7 feed registry (§2.2 onboarding FSM in `status`).
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "external_feed" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"kind" "external_feed_kind" NOT NULL,
	"display_name" text NOT NULL,
	"host" text,
	"port" integer NOT NULL,
	"protocol" "external_feed_protocol" NOT NULL,
	"channel_cert_pin" text,
	"sending_facility_allowlist" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"baa_contract_ref" text,
	"baa_expires_on" timestamp with time zone,
	"active_from" timestamp with time zone,
	"active_through" timestamp with time zone,
	"status" "external_feed_status" DEFAULT 'proposed' NOT NULL,
	"proposed_by_membership_id" uuid NOT NULL,
	"approved_by_op_id" uuid,
	"approved_by_compl_id" uuid,
	"approved_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"rate_limit_msg_per_sec" integer DEFAULT 50 NOT NULL,
	"retry_policy" jsonb DEFAULT '{"maxAttempts":5,"backoffSecs":[1,4,16,64,256]}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_feed_pkey" PRIMARY KEY ("id"),
	CONSTRAINT "external_feed_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_external_feed_org_kind" ON "external_feed" ("organization_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_external_feed_org_port_kind" ON "external_feed" ("organization_id","port","kind");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_external_feed_status" ON "external_feed" ("status");--> statement-breakpoint

-- ============================================================================================
-- §3.3 external_feed_credential — rotating channel material (secret_cipher §3.6-denylisted).
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "external_feed_credential" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"feed_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"kind" "external_feed_credential_kind" NOT NULL,
	"secret_cipher" text NOT NULL,
	"fingerprint" text NOT NULL,
	"rotated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" "external_feed_credential_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_feed_credential_pkey" PRIMARY KEY ("id"),
	CONSTRAINT "external_feed_credential_feed_id_fk" FOREIGN KEY ("feed_id") REFERENCES "public"."external_feed"("id") ON DELETE cascade,
	CONSTRAINT "external_feed_credential_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_efc_feed_status" ON "external_feed_credential" ("feed_id","status");--> statement-breakpoint

-- ============================================================================================
-- §3.3 external_feed_health — rolling per-hour rollup; composite PK (feed_id, hour_bucket).
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "external_feed_health" (
	"feed_id" uuid NOT NULL,
	"hour_bucket" timestamp with time zone NOT NULL,
	"organization_id" uuid NOT NULL,
	"listener_up_seconds" integer DEFAULT 0 NOT NULL,
	"listener_down_seconds" integer DEFAULT 0 NOT NULL,
	"inbound_message_count" integer DEFAULT 0 NOT NULL,
	"outbound_message_count" integer DEFAULT 0 NOT NULL,
	"ack_aa_count" integer DEFAULT 0 NOT NULL,
	"ack_ae_count" integer DEFAULT 0 NOT NULL,
	"ack_ar_count" integer DEFAULT 0 NOT NULL,
	"ack_timeout_count" integer DEFAULT 0 NOT NULL,
	"inbound_bytes" bigint DEFAULT 0 NOT NULL,
	"outbound_bytes" bigint DEFAULT 0 NOT NULL,
	"parse_error_count" integer DEFAULT 0 NOT NULL,
	"sender_rejected_count" integer DEFAULT 0 NOT NULL,
	"last_message_at" timestamp with time zone,
	CONSTRAINT "external_feed_health_pkey" PRIMARY KEY ("feed_id","hour_bucket"),
	CONSTRAINT "external_feed_health_feed_id_fk" FOREIGN KEY ("feed_id") REFERENCES "public"."external_feed"("id") ON DELETE cascade,
	CONSTRAINT "external_feed_health_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_efh_org_bucket" ON "external_feed_health" ("organization_id","hour_bucket");--> statement-breakpoint

-- ============================================================================================
-- §3.3 lab_observation_inbound_link — the OBR-2 → M11 order / candidate-patient routing record.
-- UNPARTITIONED; observation_id / source_message_id reference PARTITIONED parents (LOGICAL uuids).
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "lab_observation_inbound_link" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"observation_id" uuid NOT NULL,
	"source_message_id" uuid NOT NULL,
	"source_order_id" uuid,
	"obr_placer_order_number" text,
	"match_method" "lab_match_method" NOT NULL,
	"match_confidence" numeric(4, 3),
	"candidate_patient_id" uuid,
	"candidate_match_level" "hl7_inbound_match_level",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lab_observation_inbound_link_pkey" PRIMARY KEY ("id"),
	CONSTRAINT "lab_observation_inbound_link_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_lol_observation" ON "lab_observation_inbound_link" ("observation_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_lol_placer" ON "lab_observation_inbound_link" ("obr_placer_order_number") WHERE obr_placer_order_number IS NOT NULL;--> statement-breakpoint

-- ============================================================================================
-- §3.3 nppes_provider — the cached CMS public directory (platform-shared, keyed by the 10-char NPI).
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "nppes_provider" (
	"npi" char(10) NOT NULL,
	"enumeration_type" "nppes_enumeration_type" NOT NULL,
	"status" "nppes_provider_status" NOT NULL,
	"deactivation_date" date,
	"deactivation_reason" text,
	"reactivation_date" date,
	"basic" jsonb NOT NULL,
	"addresses" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"taxonomies" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"identifiers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"endpoints" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_updated_in_nppes" date,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "nppes_provider_pkey" PRIMARY KEY ("npi")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_np_status" ON "nppes_provider" ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_np_fetched_at" ON "nppes_provider" ("fetched_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_np_last_updated" ON "nppes_provider" ("last_updated_in_nppes");--> statement-breakpoint

-- ============================================================================================
-- §3.3 nppes_sync_run — the nightly-sync orchestration log (platform-shared).
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "nppes_sync_run" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"kind" "nppes_sync_kind" NOT NULL,
	"triggered_by" "nppes_sync_trigger" NOT NULL,
	"triggered_by_membership_id" uuid,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"status" "nppes_sync_status" DEFAULT 'in_progress' NOT NULL,
	"providers_fetched_count" integer DEFAULT 0 NOT NULL,
	"providers_updated_count" integer DEFAULT 0 NOT NULL,
	"providers_deactivated_count" integer DEFAULT 0 NOT NULL,
	"errors_count" integer DEFAULT 0 NOT NULL,
	"error_details" jsonb,
	"source_file_url" text,
	CONSTRAINT "nppes_sync_run_pkey" PRIMARY KEY ("id")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_nsr_started" ON "nppes_sync_run" ("started_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_nsr_status" ON "nppes_sync_run" ("status");
