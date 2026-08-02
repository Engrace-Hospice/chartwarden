-- M35 Subscription Billing §3.3 — the ELEVEN unpartitioned tenant-scoped owned tables. The twelfth
-- tenant table (`usage_event`, monthly-partitioned by recorded_at) lands in 0142, in its OWN file because
-- check-ddl-legality rule 1 derives one partition column per FILE and then requires every UNIQUE/PK in
-- that file to include it — the eleven tables here are keyed on `id` (or natural Stripe keys) alone. RLS,
-- grants and the M4 write-audit triggers land in 0143.
--
-- TENANT-SCOPED (organization_id NOT NULL, canonical app.org_id RLS in 0143). NONE is PHI-bearing:
-- patient/user activity is stored only as a 32-hex HMAC pseudonym (W-SB-08), never a raw patient_id, so
-- the three-column rule (provider_entity_id + location_id) does not attach.
--
-- FK POLICY (M35-F04 / ADR-0011 / ARCH-147): every organization_id (and every *_membership_id) is a
-- LOGICAL uuid — RLS-governed, resolved via the OrganizationReader / MembershipReader seams + request
-- context, NO cross-module .references() into M1/M2. Intra-M35 parents carry REAL FKs: subscription.plan_id
-- → plan (0140); invoice.subscription_id / *_state_history / usage_period_aggregate / dunning_state /
-- promo_code_application → subscription; invoice_line.invoice_id / refund.invoice_id → invoice;
-- invoice_line.plan_meter_id → plan_meter (0140); promo_code_application.promo_code_id → promo_code (0140).

-- §3.3 `subscription` — one live subscription per Organization (partial-unique enforces it).
CREATE TABLE IF NOT EXISTS "subscription" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"stripe_customer_id" text,
	"stripe_subscription_id" text,
	"status" "subscription_status" DEFAULT 'trialing' NOT NULL,
	"trial_ends_at" timestamp with time zone,
	"current_period_start" timestamp with time zone,
	"current_period_end" timestamp with time zone,
	"billing_anchor_day" integer,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"canceled_at" timestamp with time zone,
	"paused_at" timestamp with time zone,
	"paused_until" timestamp with time zone,
	"dunning_started_at" timestamp with time zone,
	"default_payment_method_id" uuid,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscription_pkey" PRIMARY KEY ("id"),
	CONSTRAINT "subscription_plan_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plan"("id") ON DELETE restrict
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "subscription_org_active_uq" ON "subscription" ("organization_id") WHERE status NOT IN ('canceled', 'paused');--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "subscription_stripe_customer_uq" ON "subscription" ("stripe_customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "subscription_stripe_subscription_uq" ON "subscription" ("stripe_subscription_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subscription_status_ix" ON "subscription" ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subscription_period_end_ix" ON "subscription" ("current_period_end");--> statement-breakpoint

-- §3.3 `subscription_state_history` — append-only §2.2 transition ledger.
CREATE TABLE IF NOT EXISTS "subscription_state_history" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"subscription_id" uuid NOT NULL,
	"from_status" "subscription_status",
	"to_status" "subscription_status" NOT NULL,
	"transitioned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_membership_id" uuid,
	"reason_code" text NOT NULL,
	"reason_detail" text,
	"stripe_event_id" text,
	"m4_audit_event_id" uuid,
	CONSTRAINT "subscription_state_history_pkey" PRIMARY KEY ("id"),
	CONSTRAINT "subscription_state_history_subscription_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscription"("id") ON DELETE restrict
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subscription_state_history_sub_ix" ON "subscription_state_history" ("subscription_id","transitioned_at");--> statement-breakpoint

-- §3.3 `payment_method` — Stripe-mirrored metadata only (no PAN, no CVV).
CREATE TABLE IF NOT EXISTS "payment_method" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"stripe_payment_method_id" text NOT NULL,
	"kind" "payment_method_kind" NOT NULL,
	"card_brand" text,
	"card_last4" text,
	"card_exp_month" integer,
	"card_exp_year" integer,
	"card_wallet_kind" text,
	"ach_bank_name" text,
	"ach_account_last4" text,
	"ach_account_type" text,
	"sepa_country" text,
	"sepa_last4" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"expires_at" timestamp with time zone,
	"attached_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deactivated_at" timestamp with time zone,
	"last_synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_method_pkey" PRIMARY KEY ("id")
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payment_method_stripe_pm_uq" ON "payment_method" ("stripe_payment_method_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payment_method_org_default_uq" ON "payment_method" ("organization_id") WHERE is_default = true AND is_active = true;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_method_org_active_ix" ON "payment_method" ("organization_id","is_active");--> statement-breakpoint

-- §3.3 `invoice` — Stripe-authoritative mirror (copied to platform_retained_invoice on offboarding).
CREATE TABLE IF NOT EXISTS "invoice" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"subscription_id" uuid,
	"stripe_invoice_id" text NOT NULL,
	"invoice_number" text,
	"status" "invoice_status" DEFAULT 'draft' NOT NULL,
	"subtotal_cents" bigint DEFAULT 0 NOT NULL,
	"tax_cents" bigint DEFAULT 0 NOT NULL,
	"total_cents" bigint DEFAULT 0 NOT NULL,
	"amount_paid_cents" bigint DEFAULT 0 NOT NULL,
	"amount_due_cents" bigint DEFAULT 0 NOT NULL,
	"currency_code" text DEFAULT 'USD' NOT NULL,
	"period_start" timestamp with time zone,
	"period_end" timestamp with time zone,
	"issued_at" timestamp with time zone,
	"due_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"voided_at" timestamp with time zone,
	"hosted_invoice_url" text,
	"invoice_pdf_url" text,
	"last_synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoice_pkey" PRIMARY KEY ("id"),
	CONSTRAINT "invoice_subscription_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscription"("id") ON DELETE restrict
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "invoice_stripe_invoice_uq" ON "invoice" ("stripe_invoice_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invoice_org_status_ix" ON "invoice" ("organization_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invoice_number_ix" ON "invoice" ("invoice_number");--> statement-breakpoint

-- §3.3 `invoice_line`.
CREATE TABLE IF NOT EXISTS "invoice_line" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"stripe_line_id" text NOT NULL,
	"kind" "invoice_line_kind" NOT NULL,
	"description" text NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"unit_amount_cents" bigint DEFAULT 0 NOT NULL,
	"total_cents" bigint DEFAULT 0 NOT NULL,
	"period_start" timestamp with time zone,
	"period_end" timestamp with time zone,
	"meter_event_type" "usage_event_type",
	"plan_meter_id" uuid,
	CONSTRAINT "invoice_line_pkey" PRIMARY KEY ("id"),
	CONSTRAINT "invoice_line_invoice_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoice"("id") ON DELETE restrict,
	CONSTRAINT "invoice_line_plan_meter_id_fk" FOREIGN KEY ("plan_meter_id") REFERENCES "public"."plan_meter"("id") ON DELETE set null
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "invoice_line_stripe_line_uq" ON "invoice_line" ("stripe_line_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invoice_line_invoice_ix" ON "invoice_line" ("invoice_id");--> statement-breakpoint

-- §3.3 `usage_period_aggregate` — one row per (subscription, event_type, period).
CREATE TABLE IF NOT EXISTS "usage_period_aggregate" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"subscription_id" uuid NOT NULL,
	"event_type" "usage_event_type" NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"total_quantity" bigint DEFAULT 0 NOT NULL,
	"inclusive_quantity" bigint DEFAULT 0 NOT NULL,
	"overage_quantity" bigint DEFAULT 0 NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"stripe_usage_record_id" text,
	"posted_at" timestamp with time zone,
	"post_attempt_count" integer DEFAULT 0 NOT NULL,
	"warning_emitted_at" timestamp with time zone,
	"breach_emitted_at" timestamp with time zone,
	CONSTRAINT "usage_period_aggregate_pkey" PRIMARY KEY ("id"),
	CONSTRAINT "usage_period_aggregate_subscription_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscription"("id") ON DELETE restrict
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "usage_period_aggregate_uq" ON "usage_period_aggregate" ("subscription_id","event_type","period_start","period_end");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "usage_period_aggregate_unposted_ix" ON "usage_period_aggregate" ("computed_at") WHERE stripe_usage_record_id IS NULL;--> statement-breakpoint

-- §3.3 `patient_active_period` — pseudonymized (32-hex HMAC), NEVER a raw patient_id.
CREATE TABLE IF NOT EXISTS "patient_active_period" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"patient_pseudonym" text NOT NULL,
	"pseudonym_key_epoch" text NOT NULL,
	"period_year_month" text NOT NULL,
	"was_active" boolean DEFAULT false NOT NULL,
	"became_active_at" timestamp with time zone,
	"became_inactive_at" timestamp with time zone,
	"inactivity_reason" "inactivity_reason",
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "patient_active_period_pkey" PRIMARY KEY ("id"),
	CONSTRAINT "patient_active_period_pseudonym_format_ck" CHECK (patient_pseudonym ~ '^[a-f0-9]{32}$')
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "patient_active_period_uq" ON "patient_active_period" ("organization_id","patient_pseudonym","period_year_month");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "patient_active_period_org_period_ix" ON "patient_active_period" ("organization_id","period_year_month");--> statement-breakpoint

-- §3.3 `user_active_period` — pseudonymized (32-hex HMAC), NEVER a raw membership_id.
CREATE TABLE IF NOT EXISTS "user_active_period" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"membership_pseudonym" text NOT NULL,
	"pseudonym_key_epoch" text NOT NULL,
	"period_year_month" text NOT NULL,
	"was_active" boolean DEFAULT false NOT NULL,
	"first_session_at" timestamp with time zone,
	"last_session_at" timestamp with time zone,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_active_period_pkey" PRIMARY KEY ("id"),
	CONSTRAINT "user_active_period_pseudonym_format_ck" CHECK (membership_pseudonym ~ '^[a-f0-9]{32}$')
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "user_active_period_uq" ON "user_active_period" ("organization_id","membership_pseudonym","period_year_month");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_active_period_org_period_ix" ON "user_active_period" ("organization_id","period_year_month");--> statement-breakpoint

-- §3.3 `dunning_state` — the §4.15 dunning state machine (D7).
CREATE TABLE IF NOT EXISTS "dunning_state" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"subscription_id" uuid NOT NULL,
	"stage" "dunning_stage" NOT NULL,
	"entered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"exited_at" timestamp with time zone,
	"exit_reason" text,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"last_attempt_failure_code" text,
	"trigger_invoice_id" uuid,
	CONSTRAINT "dunning_state_pkey" PRIMARY KEY ("id"),
	CONSTRAINT "dunning_state_subscription_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscription"("id") ON DELETE restrict
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dunning_state_sub_stage_ix" ON "dunning_state" ("subscription_id","stage");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dunning_state_open_ix" ON "dunning_state" ("subscription_id") WHERE exited_at IS NULL;--> statement-breakpoint

-- §3.3 `promo_code_application`.
CREATE TABLE IF NOT EXISTS "promo_code_application" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"subscription_id" uuid NOT NULL,
	"promo_code_id" uuid NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL,
	"applied_by_membership_id" uuid NOT NULL,
	"started_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	"m4_audit_event_id" uuid,
	CONSTRAINT "promo_code_application_pkey" PRIMARY KEY ("id"),
	CONSTRAINT "promo_code_application_subscription_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscription"("id") ON DELETE restrict,
	CONSTRAINT "promo_code_application_promo_code_id_fk" FOREIGN KEY ("promo_code_id") REFERENCES "public"."promo_code"("id") ON DELETE restrict
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "promo_code_application_sub_active_uq" ON "promo_code_application" ("subscription_id","promo_code_id") WHERE revoked_at IS NULL;--> statement-breakpoint

-- §3.3 `refund` — the §D16 four-stage refund workflow.
CREATE TABLE IF NOT EXISTS "refund" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"stripe_refund_id" text,
	"amount_cents" bigint NOT NULL,
	"kind" "refund_kind" NOT NULL,
	"reason_code" text NOT NULL,
	"reason_detail" text NOT NULL,
	"requested_by_membership_id" uuid NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"approved_by_membership_id" uuid,
	"approved_at" timestamp with time zone,
	"approver_step_up_audit_event_id" uuid,
	"denied_by_membership_id" uuid,
	"denied_at" timestamp with time zone,
	"denied_reason" text,
	"executed_at" timestamp with time zone,
	"status" "refund_status" DEFAULT 'requested' NOT NULL,
	"stripe_failure_code" text,
	CONSTRAINT "refund_pkey" PRIMARY KEY ("id"),
	CONSTRAINT "refund_invoice_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoice"("id") ON DELETE restrict,
	CONSTRAINT "refund_reason_detail_min_len" CHECK (length(reason_detail) >= 40),
	CONSTRAINT "refund_amount_positive" CHECK (amount_cents > 0)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "refund_invoice_ix" ON "refund" ("invoice_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "refund_status_ix" ON "refund" ("status");
