-- M35 Subscription Billing §3.2/§3.3 — the FOURTEEN enum types (Phase 1) and the NINE platform-shared /
-- platform-only owned tables (Phase 2). The twelve tenant-scoped tables land in 0141 (eleven
-- unpartitioned) and 0142 (`usage_event`, monthly-partitioned). RLS, grants and the M4 write-audit
-- triggers land in 0143.
--
-- TENANCY (ARCH-011 / ADR-0010): these nine tables carry NO tenant-RLS organization_id BY DESIGN and are
-- listed in check-tenancy.ts's NON_ORG_SCOPED set.
--   • plan / plan_meter / promo_code            — platform-owned pricing + coupon catalog (D11), read-all.
--   • revenue_recognition_snapshot              — cross-tenant MRR/ARR aggregate (W-SB-15), platform-only.
--   • patient_pseudonym_key                     — M35-private HMAC key catalog, platform-only; §3.6 grants
--                                                 it FULL audit exclusion (NO trigger in 0143).
--   • stripe_webhook_event / stripe_api_call_audit — a single Stripe webhook / API call may carry data
--                                                 spanning multiple tenants, so these ledgers are
--                                                 platform-only. `stripe_api_call_audit` DOES carry a
--                                                 nullable organization_id column.
--   • platform_retained_invoice(_line)          — M35-F06 (ARCH-186/085/251): 7-year invoice-retention
--                                                 tables. Invoice rows are COPIED here from the
--                                                 tenant-scoped `invoice` table on offboarding
--                                                 (copy-then-delete). `original_organization_id` is
--                                                 forensic traceability only, never a tenant RLS column.
--
-- NONE OF THE M35 TABLES IS PHI-BEARING: patient/user activity is stored only as a 32-hex HMAC pseudonym
-- (W-SB-08), never a raw patient_id.
--
-- FK POLICY (M35-F04 / ADR-0011 / ARCH-147): every organization_id is a LOGICAL uuid (RLS-governed, no
-- cross-module .references() into M1/M2). Intra-M35 parents carry REAL FKs: plan_meter.plan_id → plan;
-- platform_retained_invoice_line.retained_invoice_id → platform_retained_invoice.

-- ============================================================================================
-- Phase 1 — the fourteen enum types.
-- ============================================================================================
CREATE TYPE "public"."plan_tier" AS ENUM('starter', 'professional', 'enterprise');--> statement-breakpoint
CREATE TYPE "public"."billing_cadence" AS ENUM('monthly', 'annual');--> statement-breakpoint
CREATE TYPE "public"."subscription_status" AS ENUM('trialing', 'active', 'past_due', 'at_risk', 'suspended', 'canceled', 'paused');--> statement-breakpoint
CREATE TYPE "public"."dunning_stage" AS ENUM('none', 'day_1', 'day_7', 'day_14', 'day_21', 'day_28_suspend', 'day_60_cancel', 'resolved');--> statement-breakpoint
CREATE TYPE "public"."invoice_status" AS ENUM('draft', 'open', 'paid', 'void', 'uncollectible');--> statement-breakpoint
CREATE TYPE "public"."invoice_line_kind" AS ENUM('subscription', 'metered', 'one_time', 'tax', 'discount', 'credit', 'proration');--> statement-breakpoint
CREATE TYPE "public"."refund_status" AS ENUM('requested', 'approved', 'denied', 'executed_success', 'executed_failed');--> statement-breakpoint
CREATE TYPE "public"."refund_kind" AS ENUM('full', 'partial', 'credit_only');--> statement-breakpoint
CREATE TYPE "public"."promo_kind" AS ENUM('percent_off', 'amount_off');--> statement-breakpoint
CREATE TYPE "public"."promo_duration" AS ENUM('once', 'repeating', 'forever');--> statement-breakpoint
CREATE TYPE "public"."payment_method_kind" AS ENUM('card', 'us_bank_account', 'sepa_debit', 'other');--> statement-breakpoint
CREATE TYPE "public"."usage_event_type" AS ENUM('active_patient', 'active_user', 'claim_submitted_medicare', 'claim_submitted_medicaid', 'ai_tokens_consumed', 'fhir_egress_request', 'hl7_message_inbound', 'hl7_message_outbound');--> statement-breakpoint
CREATE TYPE "public"."usage_event_source_module" AS ENUM('m1', 'm2', 'm5', 'm23', 'm24', 'm28', 'm29', 'm32');--> statement-breakpoint
CREATE TYPE "public"."inactivity_reason" AS ENUM('discharged', 'died', 'revoked', 'transferred');--> statement-breakpoint

-- ============================================================================================
-- Phase 2 — the nine platform-shared / platform-only tables.
-- ============================================================================================
-- §3.3 `plan` — the platform-owned pricing catalog (D11).
CREATE TABLE IF NOT EXISTS "plan" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"tier" "plan_tier" NOT NULL,
	"cadence" "billing_cadence" NOT NULL,
	"base_price_cents" bigint NOT NULL,
	"currency_code" text DEFAULT 'USD' NOT NULL,
	"trial_period_days" integer DEFAULT 14 NOT NULL,
	"is_active" boolean DEFAULT false NOT NULL,
	"deprecated_at" timestamp with time zone,
	"stripe_product_id" text,
	"stripe_price_id" text,
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_to" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plan_pkey" PRIMARY KEY ("id")
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "plan_slug_uq" ON "plan" ("slug");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "plan_tier_cadence_ix" ON "plan" ("tier","cadence");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "plan_active_ix" ON "plan" ("is_active") WHERE is_active = true;--> statement-breakpoint

-- §3.3 `plan_meter` — one row per (plan, metered event type).
CREATE TABLE IF NOT EXISTS "plan_meter" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"plan_id" uuid NOT NULL,
	"event_type" "usage_event_type" NOT NULL,
	"inclusive_quantity" bigint DEFAULT 0 NOT NULL,
	"overage_unit_price_cents" bigint NOT NULL,
	"billing_aggregation" text NOT NULL,
	"stripe_meter_id" text,
	"warning_threshold_percent" integer DEFAULT 80 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plan_meter_pkey" PRIMARY KEY ("id"),
	CONSTRAINT "plan_meter_plan_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plan"("id") ON DELETE restrict
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "plan_meter_plan_event_uq" ON "plan_meter" ("plan_id","event_type");--> statement-breakpoint

-- §3.3 `promo_code` — mirror of a Stripe coupon + promotion code.
CREATE TABLE IF NOT EXISTS "promo_code" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"stripe_coupon_id" text NOT NULL,
	"stripe_promotion_code_id" text NOT NULL,
	"code" text NOT NULL,
	"kind" "promo_kind" NOT NULL,
	"percent_off" integer,
	"fixed_off_cents" bigint,
	"duration" "promo_duration" NOT NULL,
	"duration_in_months" integer,
	"valid_from" timestamp with time zone,
	"valid_to" timestamp with time zone,
	"max_redemptions" integer,
	"redemption_count" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "promo_code_pkey" PRIMARY KEY ("id")
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "promo_code_code_uq" ON "promo_code" ("code");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "promo_code_stripe_coupon_uq" ON "promo_code" ("stripe_coupon_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "promo_code_stripe_promo_uq" ON "promo_code" ("stripe_promotion_code_id");--> statement-breakpoint

-- §3.3 `revenue_recognition_snapshot` — cross-tenant monthly MRR/ARR aggregate (platform-only).
CREATE TABLE IF NOT EXISTS "revenue_recognition_snapshot" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"snapshot_month" text NOT NULL,
	"mrr_cents" bigint NOT NULL,
	"arr_cents" bigint NOT NULL,
	"new_mrr_cents" bigint NOT NULL,
	"expansion_mrr_cents" bigint NOT NULL,
	"contraction_mrr_cents" bigint NOT NULL,
	"churn_mrr_cents" bigint NOT NULL,
	"active_subscriptions" integer NOT NULL,
	"trialing_subscriptions" integer NOT NULL,
	"past_due_subscriptions" integer NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "revenue_recognition_snapshot_pkey" PRIMARY KEY ("id")
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "revenue_recognition_snapshot_month_uq" ON "revenue_recognition_snapshot" ("snapshot_month");--> statement-breakpoint

-- §3.3 `patient_pseudonym_key` — M35-private HMAC key catalog (platform-only; envelope-encrypted key bytes).
CREATE TABLE IF NOT EXISTS "patient_pseudonym_key" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"key_epoch" text NOT NULL,
	"key_material_ciphertext" text NOT NULL,
	"key_kms_ref" text NOT NULL,
	"is_active" boolean DEFAULT false NOT NULL,
	"activated_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "patient_pseudonym_key_pkey" PRIMARY KEY ("id")
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "patient_pseudonym_key_epoch_uq" ON "patient_pseudonym_key" ("key_epoch");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "patient_pseudonym_key_one_active_uq" ON "patient_pseudonym_key" ("is_active") WHERE is_active = true;--> statement-breakpoint

-- §3.3 `stripe_webhook_event` — platform-only; envelope-encrypted payload (D15). PK is the Stripe event id.
CREATE TABLE IF NOT EXISTS "stripe_webhook_event" (
	"id" text NOT NULL,
	"event_type" text NOT NULL,
	"api_version" text,
	"payload_ciphertext" text NOT NULL,
	"payload_dek_ref" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"processing_attempt_count" integer DEFAULT 0 NOT NULL,
	"signature_verified_at" timestamp with time zone NOT NULL,
	"error_text" text,
	"derived_organization_id" text,
	CONSTRAINT "stripe_webhook_event_pkey" PRIMARY KEY ("id")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stripe_webhook_event_type_received_ix" ON "stripe_webhook_event" ("event_type","received_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stripe_webhook_event_unprocessed_ix" ON "stripe_webhook_event" ("received_at") WHERE processed_at IS NULL;--> statement-breakpoint

-- §3.3 `stripe_api_call_audit` — platform-only append-only outbound-call ledger (nullable organization_id).
CREATE TABLE IF NOT EXISTS "stripe_api_call_audit" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"stripe_idempotency_key" text NOT NULL,
	"operation" text NOT NULL,
	"target_resource_id" text,
	"organization_id" uuid,
	"request_envelope_redacted" jsonb NOT NULL,
	"response_status_code" integer,
	"response_envelope_redacted" jsonb,
	"called_at" timestamp with time zone DEFAULT now() NOT NULL,
	"latency_ms" integer,
	"attempt_index" integer DEFAULT 0 NOT NULL,
	"error_text" text,
	CONSTRAINT "stripe_api_call_audit_pkey" PRIMARY KEY ("id")
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "stripe_api_call_audit_idem_uq" ON "stripe_api_call_audit" ("stripe_idempotency_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stripe_api_call_audit_op_called_ix" ON "stripe_api_call_audit" ("operation","called_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stripe_api_call_audit_org_ix" ON "stripe_api_call_audit" ("organization_id","called_at");--> statement-breakpoint

-- §3.7 `platform_retained_invoice` — M35-F06 7-year invoice retention (platform-only, copy-then-delete).
CREATE TABLE IF NOT EXISTS "platform_retained_invoice" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"original_invoice_id" uuid NOT NULL,
	"original_organization_id" uuid NOT NULL,
	"transferred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retain_until" timestamp with time zone NOT NULL,
	"stripe_invoice_id" text NOT NULL,
	"invoice_number" text,
	"status" "invoice_status" NOT NULL,
	"subtotal_cents" bigint NOT NULL,
	"tax_cents" bigint NOT NULL,
	"total_cents" bigint NOT NULL,
	"amount_paid_cents" bigint NOT NULL,
	"currency_code" text NOT NULL,
	"period_start" timestamp with time zone,
	"period_end" timestamp with time zone,
	"issued_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	CONSTRAINT "platform_retained_invoice_pkey" PRIMARY KEY ("id")
);--> statement-breakpoint

-- §3.7 `platform_retained_invoice_line` — companion line rows (parent FK → platform_retained_invoice).
CREATE TABLE IF NOT EXISTS "platform_retained_invoice_line" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"original_invoice_line_id" uuid NOT NULL,
	"retained_invoice_id" uuid NOT NULL,
	"original_invoice_id" uuid NOT NULL,
	"original_organization_id" uuid NOT NULL,
	"transferred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retain_until" timestamp with time zone NOT NULL,
	"stripe_line_id" text NOT NULL,
	"kind" "invoice_line_kind" NOT NULL,
	"description" text NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"unit_amount_cents" bigint DEFAULT 0 NOT NULL,
	"total_cents" bigint DEFAULT 0 NOT NULL,
	"period_start" timestamp with time zone,
	"period_end" timestamp with time zone,
	"meter_event_type" "usage_event_type",
	CONSTRAINT "platform_retained_invoice_line_pkey" PRIMARY KEY ("id"),
	CONSTRAINT "platform_retained_invoice_line_retained_invoice_id_fk" FOREIGN KEY ("retained_invoice_id") REFERENCES "public"."platform_retained_invoice"("id") ON DELETE restrict
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_retained_invoice_line_invoice_ix" ON "platform_retained_invoice_line" ("retained_invoice_id");
