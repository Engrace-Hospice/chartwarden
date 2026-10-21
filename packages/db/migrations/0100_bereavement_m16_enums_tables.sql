-- M16 Bereavement §3.2/§3.3 — the 14 enum types + the EIGHT unpartitioned owned tables with their indexes
-- and CHECKs. The ninth table (bereavement_contact_log, monthly PARTITION BY RANGE (contact_at)) lands in
-- its own file 0101; RLS, grants, the M4 write-audit triggers and the risk-score immutability trigger in
-- 0102.
--
-- WHY THE CONTACT LOG IS SPLIT OUT: check-ddl-legality rule 1 derives ONE partition column per FILE from the
-- first PARTITION BY it sees and then requires every UNIQUE/PK in that file to include it. The eight tables
-- here are keyed on `id` alone; only the log carries the composite (id, contact_at). Co-habiting would fail
-- the gate (the M25 0081/0082 and M24 0093/0094/0095 precedent).
--
-- D12 / §3.6 — WHY ONLY ONE TABLE IS PARTITIONED: the other eight are current-row tables at bounded volume
-- (one plan per decedent admission per tenant; ~10 bereaved contacts per plan; ~20 touchpoints per contact
-- across 13 months → ~100K outreach rows/year even for a 1,000-death tenant). Every dominant query is a
-- current-row read — "my caseload", "what is due this week", "this plan's roster" — which a RANGE partition
-- would force to fan out across partitions for no benefit.
--
-- TENANCY (ARCH-011 / ADR-0010 / §3.5): every table carries organization_id NOT NULL. The seven
-- patient-bearing tables here also carry provider_entity_id NOT NULL + location_id (NULLABLE — the
-- already-published `BereavementPlanView.locationId` is `LocationId | null`, because a post-death transfer
-- can leave the service location unresolved), denormalized from the plan so the §4.6
-- BereavementComplianceProvider rolls up per CCN/location without joining through the M5/M6 schemas. The
-- eighth, tenant_bereavement_external_source_gate_override, is org-level CONFIG, not a patient record: no
-- PE/location, one row per tenant, and ON DELETE cascade (an offboarded tenant's gate config has no reason
-- to outlive its organization row, unlike the clinical tables' restrict).
--
-- CROSS-MODULE FK POLICY (architecture wins): only organization_id / provider_entity_id / location_id (M1
-- core) and intra-M16 parents get real FK constraints. patient_id (M5), admission_id (M6),
-- care_plan_version_id_at_discharge (M7), source_encounter_id (M8), portal_account_id (M31),
-- consent_record_id (M39), the M22 document ids, the M32 augmentation refs, legal_hold_id (M4) and every
-- `*_user_id` / `*_membership_id` (M2 membership — the spec's `user_id` NAME is kept, but @chartwarden/types
-- already types them `MembershipId`) are LOGICAL uuid, validated at the write boundary.
CREATE TYPE "public"."bereavement_plan_status" AS ENUM('eligible', 'initiating', 'active', 'paused', 'closed_completed', 'closed_declined', 'closed_early', 'closed_legal_hold_extended');--> statement-breakpoint
CREATE TYPE "public"."bereaved_contact_status" AS ENUM('proposed', 'active', 'opted_out', 'deceased', 'unreachable', 'ineligible_post_review');--> statement-breakpoint
CREATE TYPE "public"."bereaved_contact_relationship" AS ENUM('spouse', 'domestic_partner', 'parent', 'child', 'sibling', 'grandparent', 'grandchild', 'aunt_uncle', 'cousin', 'in_law', 'friend', 'neighbor', 'clergy', 'colleague', 'caregiver_non_family', 'other');--> statement-breakpoint
CREATE TYPE "public"."bereavement_outreach_kind" AS ENUM('phone_call', 'in_person_visit', 'sympathy_card', 'sympathy_letter', 'anniversary_letter', 'email', 'portal_message', 'group_support_invitation', 'external_referral');--> statement-breakpoint
CREATE TYPE "public"."bereavement_outreach_status" AS ENUM('scheduled', 'in_progress', 'completed', 'declined', 'no_response', 'missed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."bereavement_contact_log_outcome" AS ENUM('engaged', 'brief_acknowledgement', 'declined', 'no_response', 'voicemail_left', 'wrong_number', 'returned_undeliverable', 'requested_followup', 'requested_no_further_contact', 'crisis_referral');--> statement-breakpoint
CREATE TYPE "public"."bereavement_risk_tier" AS ENUM('low', 'moderate', 'high', 'complicated');--> statement-breakpoint
CREATE TYPE "public"."bereavement_risk_score_kind" AS ENUM('rule_deterministic', 'llm_augmented');--> statement-breakpoint
CREATE TYPE "public"."bereavement_plan_closure_reason" AS ENUM('thirteen_month_completion', 'all_contacts_declined', 'patient_opt_out_pre_death', 'patient_opt_out_post_creation', 'tenant_offboarding', 'all_bereaved_deceased', 'geographic_relocation', 'family_legal_action', 'other_early');--> statement-breakpoint
CREATE TYPE "public"."bereavement_opt_out_kind" AS ENUM('full', 'channel_specific', 'pause_temporarily');--> statement-breakpoint
CREATE TYPE "public"."bereavement_plan_pause_kind" AS ENUM('operational', 'family_request', 'counselor_unavailable_temp');--> statement-breakpoint
CREATE TYPE "public"."bereavement_anniversary_mark" AS ENUM('one_month', 'three_month', 'six_month', 'nine_month_high_risk_only', 'anniversary');--> statement-breakpoint
CREATE TYPE "public"."bereavement_data_completeness" AS ENUM('complete', 'partial', 'minimal');--> statement-breakpoint
CREATE TYPE "public"."bereavement_confidence_band" AS ENUM('HIGH', 'MEDIUM', 'LOW');--> statement-breakpoint

-- ============================================================================================
-- bereavement_plan — the D1 program ROOT. One row per discharged-by-death admission (§2.2).
-- external_source_metadata is D16's provenance blob (NULL for internal-clinician-recorded deaths);
-- the partial expression index below is D18's coordinator pending-cosign queue.
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "bereavement_plan" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"admission_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"location_id" uuid,
	"status" "bereavement_plan_status" DEFAULT 'eligible' NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"death_date" date NOT NULL,
	"death_time" timestamp with time zone,
	"assigned_counselor_user_id" uuid,
	"assigned_counselor_assigned_at" timestamp with time zone,
	"assigned_volunteer_user_id" uuid,
	"assigned_volunteer_assigned_at" timestamp with time zone,
	"opened_at" timestamp with time zone,
	"paused_at" timestamp with time zone,
	"pause_kind" "bereavement_plan_pause_kind",
	"pause_reason_redacted" text,
	"closed_at" timestamp with time zone,
	"ipoc_bereavement_intent_summary_redacted" text,
	"care_plan_version_id_at_discharge" uuid,
	"current_risk_tier" "bereavement_risk_tier",
	"current_risk_computed_at" timestamp with time zone,
	"external_source_metadata" jsonb,
	"legal_hold_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "berv_plan_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "berv_plan_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict,
	CONSTRAINT "berv_plan_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict,
	CONSTRAINT "berv_plan_active_requires_counselor" CHECK ("status" NOT IN ('active', 'paused') OR "assigned_counselor_user_id" IS NOT NULL),
	CONSTRAINT "berv_plan_opened_at_required" CHECK ("status" NOT IN ('active','paused','closed_completed','closed_declined','closed_early','closed_legal_hold_extended') OR "opened_at" IS NOT NULL),
	CONSTRAINT "berv_plan_closed_at_required" CHECK ("status" NOT IN ('closed_completed','closed_declined','closed_early','closed_legal_hold_extended') OR "closed_at" IS NOT NULL),
	CONSTRAINT "berv_plan_pause_requires_kind" CHECK ("status" <> 'paused' OR "pause_kind" IS NOT NULL)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "berv_plan_unique_admission" ON "bereavement_plan" ("organization_id","admission_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "berv_plan_patient_idx" ON "bereavement_plan" ("organization_id","patient_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "berv_plan_status_idx" ON "bereavement_plan" ("organization_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "berv_plan_counselor_idx" ON "bereavement_plan" ("assigned_counselor_user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "berv_plan_death_date_idx" ON "bereavement_plan" ("organization_id","death_date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "berv_plan_provider_entity_idx" ON "bereavement_plan" ("organization_id","provider_entity_id","location_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_bereavement_plan_external_pending_cosign" ON "bereavement_plan" ((external_source_metadata->>'cosignStatus')) WHERE external_source_metadata IS NOT NULL AND external_source_metadata->>'cosignStatus' = 'pending';--> statement-breakpoint

-- ============================================================================================
-- bereaved_contact — D1's per-survivor tier. The three *_cipher columns are DEK envelope-encrypted
-- at the application layer and are deliberately NOT audit-denylisted (already unreadable; the
-- denylist would cost the audit row its only change-detection signal for a channel edit).
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "bereaved_contact" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"location_id" uuid,
	"plan_id" uuid NOT NULL,
	"status" "bereaved_contact_status" DEFAULT 'proposed' NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"display_name" text NOT NULL,
	"caregiver_id_from_m5" uuid,
	"patient_caregiver_id_from_m5" uuid,
	"relationship_code" "bereaved_contact_relationship" NOT NULL,
	"email_cipher" text,
	"phone_cipher" text,
	"mailing_address_cipher" text,
	"portal_account_id" uuid,
	"consent_record_id" uuid,
	"outreach_preferences_jsonb" jsonb DEFAULT '{"allowed_kinds":["phone_call","sympathy_card","sympathy_letter","anniversary_letter","email"]}'::jsonb NOT NULL,
	"preferred_language_iso639" text DEFAULT 'en' NOT NULL,
	"volunteer_visible_only" boolean DEFAULT false NOT NULL,
	"current_risk_tier" "bereavement_risk_tier",
	"current_risk_score_id" uuid,
	"confirmed_at" timestamp with time zone,
	"opted_out_at" timestamp with time zone,
	"unreachable_at" timestamp with time zone,
	"deceased_at" timestamp with time zone,
	"ineligible_at" timestamp with time zone,
	"ineligible_reason_redacted" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "berv_contact_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "berv_contact_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict,
	CONSTRAINT "berv_contact_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict,
	CONSTRAINT "berv_contact_plan_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."bereavement_plan"("id") ON DELETE restrict
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "berv_contact_plan_idx" ON "bereaved_contact" ("plan_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "berv_contact_status_idx" ON "bereaved_contact" ("organization_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "berv_contact_caregiver_m5_idx" ON "bereaved_contact" ("caregiver_id_from_m5") WHERE caregiver_id_from_m5 IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "berv_contact_portal_idx" ON "bereaved_contact" ("portal_account_id") WHERE portal_account_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "berv_contact_consent_idx" ON "bereaved_contact" ("consent_record_id") WHERE consent_record_id IS NOT NULL;--> statement-breakpoint

-- ============================================================================================
-- bereavement_risk_score — the APPEND-ONLY D3/D17 rubric ledger. bereaved_contact_id NULL = the
-- plan-level rollup. UPDATE is refused by the D11 immutability trigger in 0102.
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "bereavement_risk_score" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"location_id" uuid,
	"plan_id" uuid NOT NULL,
	"bereaved_contact_id" uuid,
	"score_kind" "bereavement_risk_score_kind" NOT NULL,
	"assessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"assessed_by_user_id" uuid,
	"risk_factors_jsonb" jsonb NOT NULL,
	"rule_score" integer NOT NULL,
	"rule_tier" "bereavement_risk_tier" NOT NULL,
	"data_completeness" "bereavement_data_completeness" DEFAULT 'complete' NOT NULL,
	"confidence_band" "bereavement_confidence_band" DEFAULT 'HIGH' NOT NULL,
	"augmented_score" integer,
	"augmented_tier" "bereavement_risk_tier",
	"augmented_narrative_redacted" text,
	"augmented_model_ref" text,
	"augmented_request_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "berv_risk_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "berv_risk_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict,
	CONSTRAINT "berv_risk_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict,
	CONSTRAINT "berv_risk_plan_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."bereavement_plan"("id") ON DELETE restrict,
	CONSTRAINT "berv_risk_bereaved_contact_id_fk" FOREIGN KEY ("bereaved_contact_id") REFERENCES "public"."bereaved_contact"("id") ON DELETE restrict,
	CONSTRAINT "berv_risk_llm_requires_rule" CHECK ("score_kind" <> 'llm_augmented' OR ("augmented_score" IS NOT NULL AND "augmented_model_ref" IS NOT NULL))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "berv_risk_plan_idx" ON "bereavement_risk_score" ("plan_id","assessed_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "berv_risk_contact_idx" ON "bereavement_risk_score" ("bereaved_contact_id","assessed_at") WHERE bereaved_contact_id IS NOT NULL;--> statement-breakpoint

-- ============================================================================================
-- bereavement_outreach — the D4 death-anchored schedule.
--
-- `death_anchor_at` is the denormalized plan anchor the ceiling CHECK reads. §3.3.4 writes that CHECK
-- against a denormalized `death_date` DATE (`due_at - death_date::timestamp`), but that expression
-- cannot be created: due_at is TIMESTAMPTZ, death_date::timestamp is TIMESTAMP, and the implicit
-- timestamp→timestamptz coercion PostgreSQL inserts is STABLE (it reads the session TimeZone), which a
-- CHECK constraint rejects. Storing the anchor as TIMESTAMPTZ (the plan's death date resolved once to
-- the org's local start-of-day at row creation) makes the subtraction timestamptz−timestamptz, which IS
-- immutable — identical semantics, legal DDL. 426 days = 396 (13 months) + 30 (grace), per §2.5.
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "bereavement_outreach" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"location_id" uuid,
	"plan_id" uuid NOT NULL,
	"bereaved_contact_id" uuid NOT NULL,
	"kind" "bereavement_outreach_kind" NOT NULL,
	"status" "bereavement_outreach_status" DEFAULT 'scheduled' NOT NULL,
	"anniversary_mark" "bereavement_anniversary_mark",
	"death_anchor_at" timestamp with time zone NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"late_grace_until" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancellation_reason_redacted" text,
	"assignee_user_id" uuid,
	"rendered_document_id" uuid,
	"m22_render_requested_at" timestamp with time zone,
	"m22_rendered_at" timestamp with time zone,
	"policy_version_snapshot" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "berv_outreach_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "berv_outreach_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict,
	CONSTRAINT "berv_outreach_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict,
	CONSTRAINT "berv_outreach_plan_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."bereavement_plan"("id") ON DELETE restrict,
	CONSTRAINT "berv_outreach_bereaved_contact_id_fk" FOREIGN KEY ("bereaved_contact_id") REFERENCES "public"."bereaved_contact"("id") ON DELETE restrict,
	CONSTRAINT "berv_outreach_due_within_ceiling" CHECK (EXTRACT(EPOCH FROM ("due_at" - "death_anchor_at")) / 86400 BETWEEN 0 AND 426),
	CONSTRAINT "berv_outreach_grace_after_due" CHECK ("late_grace_until" >= "due_at")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "berv_outreach_plan_due_idx" ON "bereavement_outreach" ("plan_id","due_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "berv_outreach_contact_due_idx" ON "bereavement_outreach" ("bereaved_contact_id","due_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "berv_outreach_status_due_idx" ON "bereavement_outreach" ("organization_id","status","due_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "berv_outreach_anniv_idx" ON "bereavement_outreach" ("plan_id","anniversary_mark") WHERE anniversary_mark IS NOT NULL;--> statement-breakpoint

-- ============================================================================================
-- bereavement_anniversary_reminder — the daily 14-day-lookahead worker's idempotency ledger.
-- The (plan_id, mark) unique index is what makes a cron catch-up (§9.7) fire each M36 alert once.
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "bereavement_anniversary_reminder" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"location_id" uuid,
	"plan_id" uuid NOT NULL,
	"mark" "bereavement_anniversary_mark" NOT NULL,
	"target_date" date NOT NULL,
	"alert_fired_at" timestamp with time zone,
	"outreach_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "berv_anniv_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "berv_anniv_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict,
	CONSTRAINT "berv_anniv_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict,
	CONSTRAINT "berv_anniv_plan_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."bereavement_plan"("id") ON DELETE restrict
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "berv_anniv_plan_mark_unique" ON "bereavement_anniversary_reminder" ("plan_id","mark");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "berv_anniv_target_idx" ON "bereavement_anniversary_reminder" ("organization_id","target_date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "berv_anniv_pending_idx" ON "bereavement_anniversary_reminder" ("organization_id","target_date") WHERE alert_fired_at IS NULL;--> statement-breakpoint

-- ============================================================================================
-- bereavement_plan_closure — D7's why-it-ended record. The five EARLY reasons carry BOTH the
-- clinical-supervisor cosign and the §2.5 40-char narrative floor as CHECKs, because an early close
-- is the one path that can cut a regulatory 13-month obligation short. The 13-month completion and
-- the two opt-out-driven closes carry neither (§2.6: a patient-opt-out close fires automatically).
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "bereavement_plan_closure" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"location_id" uuid,
	"plan_id" uuid NOT NULL,
	"reason" "bereavement_plan_closure_reason" NOT NULL,
	"reason_narrative_redacted" text,
	"closed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_by_user_id" uuid,
	"close_kind" text NOT NULL,
	"cosigned_by_user_id" uuid,
	"cosigned_at" timestamp with time zone,
	"outreach_completed_count" integer NOT NULL,
	"outreach_missed_count" integer NOT NULL,
	"contacts_active_count" integer NOT NULL,
	"contacts_opted_out_count" integer NOT NULL,
	"bereavement_summary_document_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "berv_closure_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "berv_closure_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict,
	CONSTRAINT "berv_closure_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict,
	CONSTRAINT "berv_closure_plan_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."bereavement_plan"("id") ON DELETE restrict,
	CONSTRAINT "berv_closure_close_kind_ck" CHECK ("close_kind" IN ('auto','manual','cascade')),
	CONSTRAINT "berv_closure_early_requires_cosign" CHECK ("reason" NOT IN ('tenant_offboarding','all_bereaved_deceased','geographic_relocation','family_legal_action','other_early') OR ("cosigned_by_user_id" IS NOT NULL AND "cosigned_at" IS NOT NULL)),
	CONSTRAINT "berv_closure_early_requires_narrative" CHECK ("reason" NOT IN ('tenant_offboarding','all_bereaved_deceased','geographic_relocation','family_legal_action','other_early') OR char_length(coalesce("reason_narrative_redacted", '')) >= 40)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "berv_closure_unique_plan" ON "bereavement_plan_closure" ("plan_id");--> statement-breakpoint

-- ============================================================================================
-- bereavement_opt_out — D9 level two (the per-contact, post-creation opt-out; level one is M5's
-- patient flag, which prevents the plan existing at all). The partial unique index is scoped to
-- opt_out_kind = 'full': a survivor may hold several live channel-specific restrictions at once,
-- but never two active FULL opt-outs (the row that drives `closed_declined`).
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "bereavement_opt_out" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"location_id" uuid,
	"bereaved_contact_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"opt_out_kind" "bereavement_opt_out_kind" NOT NULL,
	"channel_kinds" jsonb,
	"reason_redacted" text,
	"opted_out_at" timestamp with time zone DEFAULT now() NOT NULL,
	"recorded_by_user_id" uuid,
	"source_kind" text NOT NULL,
	"rescinded_at" timestamp with time zone,
	"rescinded_by_user_id" uuid,
	CONSTRAINT "berv_optout_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "berv_optout_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict,
	CONSTRAINT "berv_optout_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict,
	CONSTRAINT "berv_optout_bereaved_contact_id_fk" FOREIGN KEY ("bereaved_contact_id") REFERENCES "public"."bereaved_contact"("id") ON DELETE restrict,
	CONSTRAINT "berv_optout_plan_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."bereavement_plan"("id") ON DELETE restrict,
	CONSTRAINT "berv_optout_source_kind_ck" CHECK ("source_kind" IN ('counselor_recorded','portal_self_service','m39_revocation_cascade','written_request_uploaded')),
	CONSTRAINT "berv_optout_channel_specific_requires_kinds" CHECK ("opt_out_kind" <> 'channel_specific' OR "channel_kinds" IS NOT NULL),
	CONSTRAINT "berv_optout_rescind_after_opt_out" CHECK ("rescinded_at" IS NULL OR "rescinded_at" >= "opted_out_at")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "berv_optout_contact_idx" ON "bereavement_opt_out" ("bereaved_contact_id","opted_out_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "berv_optout_plan_idx" ON "bereavement_opt_out" ("plan_id","opted_out_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "berv_optout_active_per_contact" ON "bereavement_opt_out" ("bereaved_contact_id") WHERE rescinded_at IS NULL AND opt_out_kind = 'full';--> statement-breakpoint

-- ============================================================================================
-- tenant_bereavement_external_source_gate_override — D18's TIGHTEN-ONLY surface. There is
-- deliberately no column that can switch the medical-director cosign off: the SHAPE of this table is
-- the enforcement of "tenants may add preconditions, never remove the platform-mandated one".
-- Org-level config, so no PE/location (ARCH-011's three-column rule is for PHI-bearing rows) and
-- ON DELETE cascade rather than restrict.
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "tenant_bereavement_external_source_gate_override" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"require_death_certificate_uploaded" boolean DEFAULT false NOT NULL,
	"require_coordinator_acknowledgment" boolean DEFAULT false NOT NULL,
	"additional_rationale" text,
	"configured_by_membership_id" uuid NOT NULL,
	"configured_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "berv_gate_override_org_unique" UNIQUE("organization_id"),
	CONSTRAINT "berv_gate_override_org_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade
);
