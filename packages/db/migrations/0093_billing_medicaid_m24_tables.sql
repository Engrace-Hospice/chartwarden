-- M24 Billing — Medicaid §3.3 — the 8 NON-partitioned owned tables: the line↔encounter join, the per-attempt
-- submission + 999/277CA acknowledgment, the non-partitioned validation tables (override + rule_config), the
-- 30-day eligibility cache, the R&B contract (with its btree_gist no-overlap EXCLUDE), and the per-PE per-state
-- trading-partner credential. The PE-partitioned claim/claim_line land in 0094; the org-partitioned
-- state_history / validation_run / validation_result / rb_day land in 0095. RLS/grants 0096; M4 audit 0097.
--
-- CROSS-MODULE FK POLICY (architecture wins): only organization_id / provider_entity_id / location_id (M1
-- core) + intra-M24 non-partitioned parents (medicaid_submission, rb_arrangement) get real FK constraints.
-- All cross-module + partitioned-parent references are LOGICAL uuid (no constraint). Money is INTEGER cents.
CREATE EXTENSION IF NOT EXISTS btree_gist;--> statement-breakpoint

-- ============================================================================================
-- medicaid_claim_line_encounter — line↔encounter join (logical FKs only; PK is the pair)
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "medicaid_claim_line_encounter" (
	"medicaid_claim_line_id" uuid NOT NULL,
	"encounter_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	CONSTRAINT "medicaid_claim_line_encounter_pk" PRIMARY KEY ("medicaid_claim_line_id","encounter_id"),
	CONSTRAINT "medicaid_claim_line_encounter_org_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "medicaid_claim_line_encounter_by_org" ON "medicaid_claim_line_encounter" ("organization_id");--> statement-breakpoint

-- ============================================================================================
-- medicaid_submission — per-attempt submission record
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "medicaid_submission" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"medicaid_claim_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"service_state" varchar(2) NOT NULL,
	"channel" varchar(32) NOT NULL,
	"mco_id_snapshot" uuid,
	"medicaid_claim_control_number" varchar(32) NOT NULL,
	"attempt_index" integer DEFAULT 0 NOT NULL,
	"adapter_vendor" varchar(64) NOT NULL,
	"adapter_version" varchar(16) NOT NULL,
	"result" "m24_submission_result" DEFAULT 'pending' NOT NULL,
	"vendor_transaction_id" varchar(64),
	"vendor_payload_cipher" text,
	"vendor_payload_hash" varchar(64),
	"error_message" text,
	"error_code" varchar(64),
	"next_poll_at" timestamp with time zone,
	"submitted_at" timestamp with time zone,
	"terminal_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_membership_id" uuid,
	CONSTRAINT "medicaid_submission_pk" PRIMARY KEY ("id"),
	CONSTRAINT "medicaid_submission_org_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "medicaid_submission_pe_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "medicaid_submission_unique_attempt" ON "medicaid_submission" ("provider_entity_id","service_state","medicaid_claim_control_number","attempt_index");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "medicaid_submission_by_claim_created" ON "medicaid_submission" ("medicaid_claim_id","created_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "medicaid_submission_by_next_poll" ON "medicaid_submission" ("next_poll_at") WHERE result = 'pending_async';--> statement-breakpoint

-- ============================================================================================
-- medicaid_acknowledgment — 999/277CA-equivalent acks (FK to non-partitioned medicaid_submission)
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "medicaid_acknowledgment" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"medicaid_claim_id" uuid NOT NULL,
	"medicaid_submission_id" uuid NOT NULL,
	"kind" "m24_acknowledgment_kind" NOT NULL,
	"outcome" "m24_acknowledgment_outcome" NOT NULL,
	"payer_claim_control_number" varchar(32),
	"accepted_line_numbers" jsonb,
	"rejected_line_numbers" jsonb,
	"error_codes" jsonb,
	"raw_payload_cipher" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "medicaid_acknowledgment_pk" PRIMARY KEY ("id"),
	CONSTRAINT "medicaid_acknowledgment_org_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "medicaid_acknowledgment_submission_fk" FOREIGN KEY ("medicaid_submission_id") REFERENCES "public"."medicaid_submission"("id") ON DELETE restrict
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "medicaid_acknowledgment_by_submission_received" ON "medicaid_acknowledgment" ("medicaid_submission_id","received_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "medicaid_acknowledgment_by_claim_received" ON "medicaid_acknowledgment" ("medicaid_claim_id","received_at" DESC);--> statement-breakpoint

-- ============================================================================================
-- medicaid_validation_override — one per overridden failed result (logical FK to partitioned result)
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "medicaid_validation_override" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"medicaid_validation_result_id" uuid NOT NULL,
	"medicaid_claim_id" uuid NOT NULL,
	"rule_key" varchar(96) NOT NULL,
	"override_role_applied" varchar(32) NOT NULL,
	"reason" text NOT NULL,
	"step_up_auth_token_at" timestamp with time zone NOT NULL,
	"actor_membership_id" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "medicaid_validation_override_pk" PRIMARY KEY ("id"),
	CONSTRAINT "medicaid_validation_override_org_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "medicaid_validation_override_reason_length" CHECK (length(reason) >= 40),
	CONSTRAINT "medicaid_validation_override_step_up_fresh" CHECK (step_up_auth_token_at > at - INTERVAL '5 minutes')
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "medicaid_validation_override_unique_per_result" ON "medicaid_validation_override" ("medicaid_validation_result_id");--> statement-breakpoint

-- ============================================================================================
-- medicaid_validation_rule_config — per-tenant rule overlay
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "medicaid_validation_rule_config" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"rule_key" varchar(96) NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"parameters_overlay" jsonb,
	"is_custom" boolean DEFAULT false NOT NULL,
	"custom_predicate_dsl" jsonb,
	"custom_severity" varchar(16),
	"custom_override_role" varchar(32),
	"regulatory_required_snapshot" boolean NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_membership_id" uuid NOT NULL,
	CONSTRAINT "medicaid_validation_rule_config_pk" PRIMARY KEY ("id"),
	CONSTRAINT "medicaid_validation_rule_config_org_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "medicaid_validation_rule_config_regulatory_required_not_disabled" CHECK (NOT (regulatory_required_snapshot = true AND enabled = false)),
	CONSTRAINT "medicaid_validation_rule_config_custom_requires_dsl" CHECK ((is_custom = false) OR (is_custom = true AND custom_predicate_dsl IS NOT NULL AND custom_severity IS NOT NULL))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "medicaid_validation_rule_config_unique_per_org" ON "medicaid_validation_rule_config" ("organization_id","rule_key");--> statement-breakpoint

-- ============================================================================================
-- medicaid_eligibility_check — per-patient-per-asOfServiceDate cache (30-day freshness)
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "medicaid_eligibility_check" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid,
	"location_id" uuid,
	"patient_id" uuid NOT NULL,
	"patient_payer_id" uuid NOT NULL,
	"service_state" varchar(2) NOT NULL,
	"as_of_service_date" timestamp with time zone NOT NULL,
	"outcome" "m24_eligibility_outcome" NOT NULL,
	"mco_id" uuid,
	"mco_snapshot" jsonb,
	"recipient_id_masked_at_check" varchar(32),
	"raw_response_cipher" text,
	"vendor_transaction_id" varchar(64),
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"stale_at" timestamp with time zone NOT NULL,
	"error_message" text,
	CONSTRAINT "medicaid_eligibility_check_pk" PRIMARY KEY ("id"),
	CONSTRAINT "medicaid_eligibility_check_org_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "medicaid_eligibility_check_pe_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict,
	CONSTRAINT "medicaid_eligibility_check_location_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "medicaid_eligibility_check_by_patient_asof" ON "medicaid_eligibility_check" ("patient_id","as_of_service_date" DESC,"checked_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "medicaid_eligibility_check_by_stale_at" ON "medicaid_eligibility_check" ("stale_at") WHERE outcome IN ('active','mco_assignment');--> statement-breakpoint

-- ============================================================================================
-- rb_arrangement — per-patient-per-NF-stay R&B contract (one ACTIVE window per patient via EXCLUDE)
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "rb_arrangement" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"location_id" uuid,
	"nf_facility_mdm_id" uuid NOT NULL,
	"nf_facility_name_snapshot" varchar(200) NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_to" timestamp with time zone,
	"nf_per_diem_routine_cents" integer NOT NULL,
	"nf_per_diem_resp_cents" integer NOT NULL,
	"nf_per_diem_gip_cents" integer NOT NULL,
	"pass_through_pct" integer NOT NULL,
	"retention_pct" integer NOT NULL,
	"contract_document_id" uuid,
	"contract_started_at" timestamp with time zone,
	"contract_terminated_at" timestamp with time zone,
	"termination_reason" text,
	"supersedes_arrangement_id" uuid,
	"state" "m24_rb_arrangement_state" DEFAULT 'DRAFT' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_membership_id" uuid NOT NULL,
	"updated_by_membership_id" uuid NOT NULL,
	CONSTRAINT "rb_arrangement_pk" PRIMARY KEY ("id"),
	CONSTRAINT "rb_arrangement_org_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "rb_arrangement_pe_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict,
	CONSTRAINT "rb_arrangement_location_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict,
	CONSTRAINT "rb_arrangement_pct_sum" CHECK (pass_through_pct + retention_pct = 100),
	CONSTRAINT "rb_arrangement_pct_range" CHECK (pass_through_pct >= 0 AND pass_through_pct <= 100 AND retention_pct >= 0 AND retention_pct <= 100),
	CONSTRAINT "rb_arrangement_effective_range" CHECK (effective_to IS NULL OR effective_from <= effective_to),
	CONSTRAINT "rb_arrangement_rates_positive" CHECK (nf_per_diem_routine_cents >= 0 AND nf_per_diem_resp_cents >= 0 AND nf_per_diem_gip_cents >= 0),
	-- one ACTIVE arrangement window per patient. tstzrange over the timestamptz columns directly (no
	-- ::date cast — timestamptz→date is STABLE not IMMUTABLE and is rejected in index expressions);
	-- open-ended contracts use an 'infinity' upper bound. Mirrors the M17 time_off EXCLUDE precedent.
	CONSTRAINT "rb_arrangement_no_overlap_active" EXCLUDE USING gist (
		"patient_id" WITH =,
		tstzrange("effective_from", COALESCE("effective_to", 'infinity'::timestamptz), '[]') WITH &&
	) WHERE (state = 'ACTIVE')
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rb_arrangement_by_patient_state" ON "rb_arrangement" ("patient_id","state");--> statement-breakpoint

-- ============================================================================================
-- state_medicaid_trading_partner_credential — per-PE per-state per-channel creds (KMS-wrapped ciphers)
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "state_medicaid_trading_partner_credential" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"service_state" varchar(2) NOT NULL,
	"channel" "m24_channel" NOT NULL,
	"mco_id" uuid,
	"trading_partner_id" varchar(64) NOT NULL,
	"client_id" varchar(128),
	"client_secret_cipher" text,
	"sftp_host" varchar(200),
	"sftp_user" varchar(64),
	"sftp_key_cipher" text,
	"portal_url" text,
	"additional_config_cipher" text,
	"active_from" timestamp with time zone NOT NULL,
	"active_to" timestamp with time zone,
	"last_sandbox_test_at" timestamp with time zone,
	"last_sandbox_test_result" varchar(32),
	"last_sandbox_test_error" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_membership_id" uuid NOT NULL,
	"updated_by_membership_id" uuid NOT NULL,
	CONSTRAINT "state_medicaid_tp_pk" PRIMARY KEY ("id"),
	CONSTRAINT "state_medicaid_tp_org_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "state_medicaid_tp_pe_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict,
	CONSTRAINT "state_medicaid_tp_active_range" CHECK (active_to IS NULL OR active_from <= active_to)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "state_medicaid_tp_unique" ON "state_medicaid_trading_partner_credential" ("provider_entity_id","service_state","channel",COALESCE("mco_id", '00000000-0000-0000-0000-000000000000'::uuid));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "state_medicaid_tp_by_pe_state" ON "state_medicaid_trading_partner_credential" ("provider_entity_id","service_state");--> statement-breakpoint
