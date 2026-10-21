-- M19 On-Call Triage §3.2 Phase A + B / §3.3 — the 13 M19 enum types and the TEN owned tables with their
-- indexes and CHECK constraints. RLS, grants, the M4 write-audit triggers (with the §3.6 denylists) and the
-- §2.3 forward-transition guard land in 0108. The ≥25-protocol platform-floor seed (§3.2 Phase E / §10
-- task 5) lands with the protocol engine in M19-T03, which owns the `red_flag_match` predicate shape the
-- question rows encode.
--
-- ENUM NAMING: M19's §3.2 Phase-A block spells its type names WITHOUT an `m19_` prefix (unlike M21's
-- §3.1.1, which spells the prefix into its own normative DDL). The spec is followed verbatim; none of the
-- thirteen names collides with an existing type in the cluster, and `packages/db/src/enums.ts` (M19-T01)
-- already declares the matching pgEnums under the same names.
--
-- ONE SPEC AMENDMENT, carried from M19-T01: `triage_call_source` gains `paper_origin`. §2.7 step 1 requires
-- the BCP re-entry path to open a call with `source='paper_origin'` AND `paper_origin_flag=true`; the
-- M19-F08 amendment added the two `paper_origin_*` columns to §3.3 and never updated the §3.2 CREATE TYPE
-- block, so following Phase A verbatim would leave §2.7 unimplementable. The
-- `m19_triage_call_paper_origin_pair` CHECK below is what keeps the flag and the enum value from
-- disagreeing.
--
-- NOT PARTITIONED — a documented deviation from §10 task 3 and the §12 checklist, which ask for monthly
-- RANGE partitions on `triage_call` (opened_at), `triage_call_state_history` and `triage_call_answer`.
-- PostgreSQL requires the partition key to appear in every UNIQUE/PRIMARY KEY on a partitioned table, and
-- this module's two remaining uniqueness guarantees are both load-bearing correctness rules, not
-- conveniences:
--   • `triage_call_source_dedupe_uq` (source_outbox_event_id) IS §2.6/D10's idempotency promise — the guard
--     that a redelivered `m17.visit.no_show_detected` or `m18.evv.late_check_out_detected` opens ONE call.
--     As UNIQUE (source_outbox_event_id, opened_at) it dedupes nothing: two rows from the same event carry
--     different opened_at values. §2.7 sharpens this — a paper-origin re-entry writes opened_at as the
--     ORIGINAL call time, so it deliberately lands in a past partition.
--   • `triage_call_answer_latest_per_q_uq` (triage_call_id, question_id) WHERE correction_of_answer_id IS
--     NULL is the base of §2.2.3's correction-by-append model: exactly one ORIGINAL answer per question.
--     Partitioning by answered_at would let a second "original" answer to the same red-flag question exist
--     in the next month's partition.
-- Partitioning would additionally forbid the real FKs the three call children hang on `triage_call` (the
-- corpus rule is that nothing references a partitioned parent — M11's `order_record` children are all
-- logical). And the volume argument that justified partitioning `administration_record` /
-- `document_access_log` / `consent_eval_audit` does not hold for a human-answered after-hours phone call:
-- tens of rows per agency per night, with the dominant reads being "open cases right now" (a partial index)
-- and "this person's contacts" (a two-column index). The corpus has a well-worn conversion path if volume
-- ever changes that (0033/0035/0037 each dropped and recreated a plain table as partitioned), and by then
-- the redelivery guard belongs in the M1 outbox-consumer ledger anyway.
--
-- TENANCY (ARCH-011 / ADR-0010): eight tables carry organization_id NOT NULL. `triage_protocol` and
-- `triage_protocol_question` carry it NULLABLE on the PLATFORM-FLOOR row only, paired with the
-- `is_system_locked` discriminator and a CHECK pair in BOTH directions — enforcing only "floor ⇒ org-less"
-- would let an org-less TENANT protocol exist, invisible to its own tenant under RLS and readable by every
-- other one (the M21 `comfort_kit_template` finding). The four call tables additionally carry
-- provider_entity_id NOT NULL + location_id NULLABLE: the three-column rule is architecture and the §3.3
-- block omits it, and Location is nullable because a call is opened before the caller is matched to a
-- served person (patient_id is itself nullable at intake).
--
-- DEVIATION FROM §3.3 (documented, narrow): `triage_protocol.mandatory_escalation_tier` is the
-- `triage_escalation_tier` ENUM rather than `text`. D7 makes that column the routing target of the four
-- mandatory-escalation protocols; as text, a typo'd tier is accepted at configuration time and discovered
-- at 2 a.m. when the router finds no tier to page.
--
-- CROSS-MODULE FK POLICY (architecture wins): only organization_id / provider_entity_id / location_id (M1
-- core) and the intra-M19 parents get real FK constraints. patient_id (M5), admission_id (M6),
-- caller_caregiver_id (M5), caller_portal_session_id (M31), mdm_vendor_id (M40), source_outbox_event_id
-- (M1 outbox), linked_encounter_id (M8), linked_visit_proposal_id (M17), m17_visit_assignment_ref (M17)
-- and every `*_membership_id` (M2) are LOGICAL uuid, validated at the write boundary (the M17
-- `visit.assigned_membership_id` precedent — the Drizzle `.references()` is the ORM's view; the SQL here is
-- normative).
--
-- IDENTIFIER LENGTH: every constraint is explicitly named with an `m19_` prefix and a short table
-- abbreviation. PostgreSQL truncates identifiers at 63 characters, and Drizzle's default naming on names
-- like `triage_paper_reentry_worklist_assigned_to_membership_id_fk` truncates two DIFFERENT constraints to
-- the same string (the M16-T02 finding).
CREATE TYPE "public"."oncall_model" AS ENUM('direct', 'hybrid', 'centralized');--> statement-breakpoint
CREATE TYPE "public"."oncall_shift_status" AS ENUM('scheduled', 'active', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."oncall_shift_discipline" AS ENUM('clinical_rn', 'clinical_lpn', 'medical_director', 'msw', 'chaplain', 'external');--> statement-breakpoint
CREATE TYPE "public"."triage_call_state" AS ENUM('open', 'protocol_in_progress', 'awaiting_callback', 'disposition_pending', 'documented_pending_encounter', 'documented', 'escalated_unresolved', 'abandoned', 'closed');--> statement-breakpoint
CREATE TYPE "public"."triage_call_caller_kind" AS ENUM('patient', 'caregiver', 'external_clinician', 'portal_session', 'system_inbound', 'bereaved_family');--> statement-breakpoint
CREATE TYPE "public"."triage_call_inbound_channel" AS ENUM('phone', 'sms', 'email', 'portal_message', 'inbound_visit_failure', 'inbound_evv_anomaly', 'inbound_alert_failure');--> statement-breakpoint
CREATE TYPE "public"."triage_call_source" AS ENUM('manual', 'no_show', 'late_checkout', 'geofence_anomaly', 'm36_delivery_failure', 'paper_origin');--> statement-breakpoint
CREATE TYPE "public"."triage_disposition" AS ENUM('caregiver_education_only', 'prn_intervention_authorized', 'verbal_order_recorded', 'visit_dispatched_now', 'visit_scheduled_first_light', 'gip_admission_proposed', 'ed_transfer_acknowledged', 'pronouncement_scheduled', 'escalated_unresolved', 'abandoned');--> statement-breakpoint
CREATE TYPE "public"."triage_escalation_tier" AS ENUM('tier_1_rn_supervisor', 'tier_2_clinical_manager', 'tier_3_medical_director', 'tier_4_compliance_officer', 'tier_5_external');--> statement-breakpoint
CREATE TYPE "public"."triage_escalation_trigger" AS ENUM('manual', 'red_flag_question', 'mandatory_protocol', 'sla_breach');--> statement-breakpoint
CREATE TYPE "public"."triage_protocol_answer_type" AS ENUM('boolean', 'integer', 'scale_0_10', 'free_text', 'enum');--> statement-breakpoint
CREATE TYPE "public"."triage_risk_band" AS ENUM('low', 'medium', 'high');--> statement-breakpoint
CREATE TYPE "public"."triage_ai_confidence" AS ENUM('low', 'medium', 'high');--> statement-breakpoint

-- ============================================================================================
-- external_triage_vendor — D13 / ADR-0026. The tenant's BINDING to an external after-hours vendor for the
-- Hybrid and Centralized models. The canonical vendor ENTITY is M40's (`mdm_vendor_id`), so a vendor is not
-- re-keyed per tenant; what lives here is this tenant's attestation, adapter selection and minimization
-- profile. Created FIRST because tenant_oncall_policy and on_call_shift both reference it.
--
-- M19 MINTS NO TOKENS (ADR-0026): a vendor operator authenticates through Better Auth's
-- `external_triage_vendor` session class. There is deliberately no secret / api_key / token column here —
-- the absence is the control.
--
-- NO `baa_in_effect ⇒ baa_expires_on IS NOT NULL` CHECK: `@chartwarden/triage-vendors`'
-- `assertVendorBindingActive` (already published at M19-T01) types `baaExpiresOn` as `string | null` and
-- documents null as "no stated expiry". A NOT NULL pairing here would make a perpetual BAA unwritable and
-- would contradict a locked contract.
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "external_triage_vendor" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"mdm_vendor_id" uuid NOT NULL,
	"name" text NOT NULL,
	"adapter_key" text NOT NULL,
	"rn_coverage_attested" boolean DEFAULT false NOT NULL,
	"baa_in_effect" boolean DEFAULT false NOT NULL,
	"baa_expires_on" timestamp with time zone,
	"default_minimization_policy" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "m19_etv_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "m19_external_triage_vendor_adapter_key" CHECK (length(btrim("adapter_key")) > 0)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "external_triage_vendor_org_adapter_uq" ON "external_triage_vendor" ("organization_id","adapter_key");--> statement-breakpoint

-- ============================================================================================
-- tenant_oncall_policy — D3/D7. The per-(org, ProviderEntity) after-hours posture. ORG-LEVEL
-- CONFIGURATION: no patient column, no location column, never touched by the §3.7 eraser (the M11
-- `order_verbal_policy` / M13 `administration_policy` posture).
--
-- `emergency_contact_e164` is a §2.7 fold, not in the §3.3 block: degraded-mode class D-D names
-- "`tenant_oncall_policy.emergency_contact_e164`" as what M19 surfaces to an org-admin when M36's alert
-- circuit-breaker is open. Without the column the D-D fallback — the path that runs when the alerting
-- fabric is down at 2 a.m. — is unimplementable. It is the AGENCY's published number, not a caller's,
-- hence not in the §3.6 denylist.
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "tenant_oncall_policy" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"model" "oncall_model" DEFAULT 'direct' NOT NULL,
	"escalation_tiers" jsonb NOT NULL,
	"callback_sla_per_severity" jsonb NOT NULL,
	"state_overrides" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"external_triage_vendor_id" uuid,
	"emergency_contact_e164" text,
	"ai_protocol_suggestion_enabled" boolean DEFAULT false NOT NULL,
	"ai_hospitalization_risk_enabled" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "m19_top_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "m19_top_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict,
	CONSTRAINT "m19_top_vendor_fk" FOREIGN KEY ("external_triage_vendor_id") REFERENCES "public"."external_triage_vendor"("id") ON DELETE restrict,
	CONSTRAINT "m19_tenant_oncall_policy_vendor_required" CHECK ("model" = 'direct' OR "external_triage_vendor_id" IS NOT NULL)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tenant_oncall_policy_pe_uq" ON "tenant_oncall_policy" ("organization_id","provider_entity_id");--> statement-breakpoint

-- ============================================================================================
-- on_call_shift — §2.2.2 / D2/D3/D7. One row per covered window per ProviderEntity per discipline; the CoP
-- 418.100(c)(2) proof that someone was reachable at 2 a.m., which is why its audit rows carry the
-- `compliance` retention class even though the row holds no patient data.
--
-- §2.3 READ — "one active clinical_rn shift per (org, PE, window)" is NOT expressed as a uniqueness or
-- EXCLUDE constraint, deliberately. Read in full the rule says "AT LEAST ONE row overlapping now()": a
-- COVERAGE floor, not a de-duplication rule. §2.4 is explicit that a coverage gap must ALERT rather than
-- block (M19 is DR Tier 1 — refusing writes over a scheduling lapse converts an administrative miss into a
-- Tier-1 outage), and an EXCLUDE would additionally make the Hybrid model illegal, where an internal and an
-- external shift covering the same window is the intended shape. The gap is found by the §4.8
-- coverage-gap-watchdog, which emits `m19.oncall_shift.coverage_gap`.
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "on_call_shift" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"shift_starts_at" timestamp with time zone NOT NULL,
	"shift_ends_at" timestamp with time zone NOT NULL,
	"discipline" "oncall_shift_discipline" NOT NULL,
	"primary_on_call_membership_id" uuid,
	"backup_membership_id" uuid,
	"external_actor_id" uuid,
	"external_actor_label" text,
	"m17_visit_assignment_ref" uuid,
	"policy_snapshot" jsonb NOT NULL,
	"status" "oncall_shift_status" DEFAULT 'scheduled' NOT NULL,
	"cancellation_reason" text,
	"opened_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"compensation_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "m19_ocs_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "m19_ocs_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict,
	CONSTRAINT "m19_ocs_external_actor_fk" FOREIGN KEY ("external_actor_id") REFERENCES "public"."external_triage_vendor"("id") ON DELETE restrict,
	CONSTRAINT "m19_on_call_shift_actor_integrity" CHECK (("discipline" = 'external' AND "external_actor_id" IS NOT NULL AND "primary_on_call_membership_id" IS NULL) OR ("discipline" <> 'external' AND "primary_on_call_membership_id" IS NOT NULL AND "external_actor_id" IS NULL)),
	CONSTRAINT "m19_on_call_shift_range" CHECK ("shift_ends_at" > "shift_starts_at"),
	CONSTRAINT "m19_on_call_shift_opened_at" CHECK ("status" = 'scheduled' OR "status" = 'cancelled' OR "opened_at" IS NOT NULL),
	CONSTRAINT "m19_on_call_shift_closed_at" CHECK ("status" <> 'completed' OR "closed_at" IS NOT NULL)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "on_call_shift_active_rn_idx" ON "on_call_shift" ("provider_entity_id","shift_starts_at","shift_ends_at") WHERE discipline = 'clinical_rn' AND status = 'active';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "on_call_shift_org_window_idx" ON "on_call_shift" ("organization_id","shift_starts_at","shift_ends_at");--> statement-breakpoint

-- ============================================================================================
-- triage_protocol — D4's hybrid catalog: a PLATFORM FLOOR (organization_id IS NULL, system-locked) every
-- tenant reads and none may edit, plus tenant rows above the floor. Versions are first-class: a revision is
-- a NEW row with its own effective window, so a call in flight keeps the question set it started with.
--
-- The floor CHECK pair makes `organization_id IS NULL` ⇔ `is_system_locked` — both directions, per the M21
-- finding. `is_system_locked` is the discriminator rather than a new `is_platform_floor` column because §3.2
-- Phase E already defines the floor as exactly "organization_id IS NULL, is_system_locked = true", and a
-- second boolean saying the same thing is a second source of truth.
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "triage_protocol" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid,
	"key" text NOT NULL,
	"chief_complaint_label" text NOT NULL,
	"snomed_code" text NOT NULL,
	"discipline_required" text NOT NULL,
	"is_system_locked" boolean DEFAULT false NOT NULL,
	"requires_mandatory_escalation" boolean DEFAULT false NOT NULL,
	"mandatory_escalation_tier" "triage_escalation_tier",
	"version" text DEFAULT '1.0' NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_to" timestamp with time zone,
	"sort_order" integer DEFAULT 100 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "m19_tp_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "m19_triage_protocol_mandatory_tier" CHECK ("requires_mandatory_escalation" = false OR "mandatory_escalation_tier" IS NOT NULL),
	CONSTRAINT "m19_triage_protocol_floor_orgless" CHECK ("is_system_locked" = false OR "organization_id" IS NULL),
	CONSTRAINT "m19_triage_protocol_tenant_has_org" CHECK ("is_system_locked" = true OR "organization_id" IS NOT NULL),
	CONSTRAINT "m19_triage_protocol_effective_window" CHECK ("effective_to" IS NULL OR "effective_to" > "effective_from")
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "triage_protocol_platform_key_uq" ON "triage_protocol" ("key") WHERE organization_id IS NULL AND effective_to IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "triage_protocol_tenant_key_uq" ON "triage_protocol" ("organization_id","key") WHERE organization_id IS NOT NULL AND effective_to IS NULL;--> statement-breakpoint

-- ============================================================================================
-- triage_protocol_question — one row per question of a protocol's ordered set. D5 lives here:
-- `red_flag_match` is the SERVER-side predicate an answer is evaluated against; the client never asserts a
-- red flag, it answers a question.
--
-- DEVIATION FROM §3.3/§3.5 (documented, and the same one M21's `comfort_kit_template_medication` carries):
-- §3.3 gives this table no tenancy column and §3.5 scopes it "inherits readability from its parent
-- protocol". ADR-0010 D2 requires a row's OWN visibility to key on app.org_id — an EXISTS-subquery policy
-- makes tenancy a JOIN, so a mis-scoped parent silently widens the child, and it runs per row on every
-- catalog read. organization_id + the floor discriminator are therefore denormalized here with the same
-- CHECK pair the parent carries. Parent/child agreement is a write-boundary invariant (a CHECK cannot read
-- the parent row); the CHECK pair makes the dangerous half impossible.
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "triage_protocol_question" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"triage_protocol_id" uuid NOT NULL,
	"organization_id" uuid,
	"question_order" integer NOT NULL,
	"prompt" text NOT NULL,
	"answer_type" "triage_protocol_answer_type" NOT NULL,
	"answer_enum_values" jsonb,
	"required" boolean DEFAULT false NOT NULL,
	"is_red_flag_question" boolean DEFAULT false NOT NULL,
	"red_flag_match" jsonb,
	"is_system_locked" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "m19_tpq_protocol_fk" FOREIGN KEY ("triage_protocol_id") REFERENCES "public"."triage_protocol"("id") ON DELETE restrict,
	CONSTRAINT "m19_tpq_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "m19_triage_protocol_question_red_flag" CHECK ("is_red_flag_question" = false OR "red_flag_match" IS NOT NULL),
	CONSTRAINT "m19_triage_protocol_question_enum_values" CHECK (("answer_type" = 'enum') = ("answer_enum_values" IS NOT NULL)),
	CONSTRAINT "m19_triage_protocol_question_floor_orgless" CHECK ("is_system_locked" = false OR "organization_id" IS NULL),
	CONSTRAINT "m19_triage_protocol_question_tenant_has_org" CHECK ("is_system_locked" = true OR "organization_id" IS NOT NULL)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "triage_protocol_question_order_uq" ON "triage_protocol_question" ("triage_protocol_id","question_order");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "triage_protocol_question_protocol_idx" ON "triage_protocol_question" ("triage_protocol_id","question_order");--> statement-breakpoint

-- ============================================================================================
-- triage_call — THE after-hours clinical record. D6's nine-state lifecycle, D10's inbound provenance, D14's
-- encrypted free text, and the M19-F08 BCP paper-origin path.
--
-- The two cipher columns ride the per-tenant DEK envelope (D14), so a tenant-offboarding crypto-shred makes
-- them unreadable without a per-row delete. D14 also settles what is NOT here: M19 captures no call audio
-- in Phase 1, so `transcript_cipher` exists for structured narrative, not ASR output.
--
-- The disposition CHECK pair is the integrity §2.2.1 implies but does not state: a disposition exists only
-- from the moment it is selected (`disposition_pending → documented_pending_encounter`), and every
-- documented or closed call has one. `escalated_unresolved` and `abandoned` are BOTH dispositions and
-- states, which is why they appear in the first list and not the second.
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "triage_call" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"location_id" uuid,
	"on_call_shift_id" uuid NOT NULL,
	"patient_id" uuid,
	"admission_id" uuid,
	"caller_caregiver_id" uuid,
	"caller_kind" "triage_call_caller_kind" NOT NULL,
	"caller_portal_session_id" uuid,
	"caller_display_name" text,
	"caller_phone_e164" text,
	"caller_relationship_label" text,
	"inbound_channel" "triage_call_inbound_channel" NOT NULL,
	"source" "triage_call_source" DEFAULT 'manual' NOT NULL,
	"source_outbox_event_id" uuid,
	"chief_complaint_text" text,
	"chief_complaint_snomed" text,
	"suggested_protocol_id" uuid,
	"suggested_protocol_confidence" "triage_ai_confidence",
	"selected_protocol_id" uuid,
	"selected_protocol_version" text,
	"hospitalization_risk_band" "triage_risk_band",
	"caller_quote_cipher" text,
	"transcript_cipher" text,
	"state" "triage_call_state" DEFAULT 'open' NOT NULL,
	"disposition" "triage_disposition",
	"disposition_data" jsonb,
	"linked_encounter_id" uuid,
	"linked_verbal_order_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"linked_visit_proposal_id" uuid,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"first_response_at" timestamp with time zone,
	"documented_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"paper_origin_flag" boolean DEFAULT false NOT NULL,
	"paper_original_opened_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "m19_tc_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "m19_tc_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict,
	CONSTRAINT "m19_tc_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict,
	CONSTRAINT "m19_tc_shift_fk" FOREIGN KEY ("on_call_shift_id") REFERENCES "public"."on_call_shift"("id") ON DELETE restrict,
	CONSTRAINT "m19_tc_suggested_protocol_fk" FOREIGN KEY ("suggested_protocol_id") REFERENCES "public"."triage_protocol"("id") ON DELETE set null,
	CONSTRAINT "m19_tc_selected_protocol_fk" FOREIGN KEY ("selected_protocol_id") REFERENCES "public"."triage_protocol"("id") ON DELETE set null,
	CONSTRAINT "m19_triage_call_paper_origin_pair" CHECK (("source" = 'paper_origin') = "paper_origin_flag"),
	CONSTRAINT "m19_triage_call_paper_original_at" CHECK (("paper_origin_flag" = true) = ("paper_original_opened_at" IS NOT NULL)),
	CONSTRAINT "m19_triage_call_disposition_state" CHECK ("disposition" IS NULL OR "state" IN ('documented_pending_encounter','documented','closed','escalated_unresolved','abandoned')),
	CONSTRAINT "m19_triage_call_documented_disposition" CHECK ("state" NOT IN ('documented_pending_encounter','documented','closed') OR "disposition" IS NOT NULL),
	CONSTRAINT "m19_triage_call_closed_at" CHECK ("state" <> 'closed' OR "closed_at" IS NOT NULL)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "triage_call_shift_idx" ON "triage_call" ("on_call_shift_id","state");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "triage_call_patient_idx" ON "triage_call" ("organization_id","patient_id","opened_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "triage_call_open_pe_idx" ON "triage_call" ("provider_entity_id","state") WHERE state IN ('open','protocol_in_progress','awaiting_callback','disposition_pending','documented_pending_encounter','escalated_unresolved');--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "triage_call_source_dedupe_uq" ON "triage_call" ("source_outbox_event_id") WHERE source_outbox_event_id IS NOT NULL;--> statement-breakpoint

-- ============================================================================================
-- triage_call_answer — §2.2.3, APPEND-ONLY. A correction is a NEW row carrying `correction_of_answer_id`
-- (the M9 D9 / M5 §164.526 correction-of-record pattern); the original is never overwritten, which is what
-- lets a surveyor see that an answer changed and when.
--
-- `red_flag_hit` is computed SERVER-side from the question's `red_flag_match` and is deliberately NOT in
-- the §3.6 denylist: it is the tamper-evidence a mandatory-escalation-suppression investigation reads.
--
-- The `one_value` CHECK closes the cheapest way past `completeProtocol`: an all-NULL answer row satisfies
-- §2.3's "every required question has an answer row" while answering nothing. "Unable to answer" is a
-- recorded value, not an absence.
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "triage_call_answer" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"location_id" uuid,
	"triage_call_id" uuid NOT NULL,
	"triage_protocol_question_id" uuid NOT NULL,
	"correction_of_answer_id" uuid,
	"answer_value_text" text,
	"answer_value_int" integer,
	"answer_value_bool" boolean,
	"red_flag_hit" boolean DEFAULT false NOT NULL,
	"answered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"answered_by_membership_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "m19_tca_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "m19_tca_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict,
	CONSTRAINT "m19_tca_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict,
	CONSTRAINT "m19_tca_call_fk" FOREIGN KEY ("triage_call_id") REFERENCES "public"."triage_call"("id") ON DELETE restrict,
	CONSTRAINT "m19_tca_question_fk" FOREIGN KEY ("triage_protocol_question_id") REFERENCES "public"."triage_protocol_question"("id") ON DELETE restrict,
	CONSTRAINT "m19_tca_correction_fk" FOREIGN KEY ("correction_of_answer_id") REFERENCES "public"."triage_call_answer"("id") ON DELETE restrict,
	CONSTRAINT "m19_triage_call_answer_one_value" CHECK (num_nonnulls("answer_value_text", "answer_value_int", "answer_value_bool") = 1),
	CONSTRAINT "m19_triage_call_answer_correction_self" CHECK ("correction_of_answer_id" IS NULL OR "correction_of_answer_id" <> "id")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "triage_call_answer_call_idx" ON "triage_call_answer" ("triage_call_id","answered_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "triage_call_answer_correction_idx" ON "triage_call_answer" ("correction_of_answer_id") WHERE correction_of_answer_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "triage_call_answer_latest_per_q_uq" ON "triage_call_answer" ("triage_call_id","triage_protocol_question_id") WHERE correction_of_answer_id IS NULL;--> statement-breakpoint

-- ============================================================================================
-- triage_escalation — §2.2.4 / D7. Three of the four trigger kinds are written by the SERVER, not a human
-- (`red_flag_question`, `mandatory_protocol`, `sla_breach`), which is why a tenant cannot configure any of
-- them away. §2.2.4 also forbids a call close from auto-resolving a mandatory row.
--
-- There is deliberately NO `resolved_at ⇒ resolved_by_membership_id` companion CHECK: §2.2.4's
-- auto-resolve-on-close is a SYSTEM write with no membership behind it, and a CHECK demanding one would
-- either block that path or push it to invent an actor. Attribution for the system case lives in the M4
-- audit row's actor_kind, where a fabricated membership id would be worse than none.
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "triage_escalation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"location_id" uuid,
	"triage_call_id" uuid NOT NULL,
	"tier" "triage_escalation_tier" NOT NULL,
	"trigger_kind" "triage_escalation_trigger" NOT NULL,
	"trigger_detail" text,
	"escalated_to_membership_id" uuid,
	"escalated_to_external_actor_id" uuid,
	"escalated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"acknowledged_at" timestamp with time zone,
	"resolution" text,
	"resolved_at" timestamp with time zone,
	"resolved_by_membership_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "m19_te_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "m19_te_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict,
	CONSTRAINT "m19_te_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict,
	CONSTRAINT "m19_te_call_fk" FOREIGN KEY ("triage_call_id") REFERENCES "public"."triage_call"("id") ON DELETE restrict,
	CONSTRAINT "m19_te_external_actor_fk" FOREIGN KEY ("escalated_to_external_actor_id") REFERENCES "public"."external_triage_vendor"("id") ON DELETE restrict,
	CONSTRAINT "m19_triage_escalation_recipient" CHECK (("tier" = 'tier_5_external' AND "escalated_to_external_actor_id" IS NOT NULL AND "escalated_to_membership_id" IS NULL) OR ("tier" <> 'tier_5_external' AND "escalated_to_membership_id" IS NOT NULL AND "escalated_to_external_actor_id" IS NULL)),
	CONSTRAINT "m19_triage_escalation_ack_before_resolve" CHECK ("resolved_at" IS NULL OR "acknowledged_at" IS NOT NULL)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "triage_escalation_call_idx" ON "triage_escalation" ("triage_call_id","tier");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "triage_escalation_open_tier_idx" ON "triage_escalation" ("organization_id","tier") WHERE resolved_at IS NULL;--> statement-breakpoint

-- ============================================================================================
-- triage_call_state_history — APPEND-ONLY, one row per §2.2.1 transition (M17's `visit_state_history`
-- pattern). Two things beyond audit depend on it: §2.7's outage detection finds the BCP window by looking
-- for the GAP where no transitions occurred, and §8.3's repudiation control is exactly "every state change
-- names an actor".
--
-- `command_payload_digest` is a HASH, not the command. The command that moves a call to
-- `disposition_pending` carries clinician prose; storing it here would create a second, unscrubbed copy of
-- text the §3.6 denylist already protects on `triage_call`.
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "triage_call_state_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"location_id" uuid,
	"triage_call_id" uuid NOT NULL,
	"from_state" "triage_call_state",
	"to_state" "triage_call_state" NOT NULL,
	"transitioned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_membership_id" uuid,
	"system_actor" boolean DEFAULT false NOT NULL,
	"command_payload_digest" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "m19_tcsh_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "m19_tcsh_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict,
	CONSTRAINT "m19_tcsh_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict,
	CONSTRAINT "m19_tcsh_call_fk" FOREIGN KEY ("triage_call_id") REFERENCES "public"."triage_call"("id") ON DELETE restrict,
	CONSTRAINT "m19_triage_call_state_history_actor" CHECK ("system_actor" = true OR "actor_membership_id" IS NOT NULL),
	CONSTRAINT "m19_triage_call_state_history_changed" CHECK ("from_state" IS NULL OR "from_state" <> "to_state")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "triage_call_state_history_call_idx" ON "triage_call_state_history" ("triage_call_id","transitioned_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "triage_call_state_history_org_time_idx" ON "triage_call_state_history" ("organization_id","transitioned_at");--> statement-breakpoint

-- ============================================================================================
-- triage_paper_reentry_worklist — §2.7 / M19-F08 (DR-013/066). The TENTH owned table, added by the BCP
-- amendment the §12/§13 checklists predate. When the platform is down, after-hours calls are taken on
-- paper; on recovery the system computes which on-call shifts overlapped the outage window and writes one
-- row per shift, so the DON has a bounded, assignable list rather than a hope that someone remembers.
--
-- `outage_window_id` is deliberately NOT a FK: the outage is INFERRED from the absence of
-- `triage_call_state_history` transitions (§2.7 step 3), so there is no outage row to point at. It is the
-- correlation key grouping the worklist with the M4 `triage_paper_reentry` audit rows for one event.
--
-- The 72-hour `expires_at` is the row's OPERATIONAL lifetime (outage end + 72 h), not its retention: a
-- surveyor asking "what happened during the outage" is asking a 7-year question, which is why the audit
-- class is `compliance`.
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "triage_paper_reentry_worklist" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"location_id" uuid,
	"outage_window_id" uuid NOT NULL,
	"shift_id" uuid,
	"shift_starts_at" timestamp with time zone NOT NULL,
	"shift_ends_at" timestamp with time zone NOT NULL,
	"assigned_to_membership_id" uuid,
	"reentered_at" timestamp with time zone,
	"linked_triage_call_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "m19_tprw_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "m19_tprw_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict,
	CONSTRAINT "m19_tprw_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict,
	CONSTRAINT "m19_tprw_shift_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."on_call_shift"("id") ON DELETE restrict,
	CONSTRAINT "m19_tprw_call_fk" FOREIGN KEY ("linked_triage_call_id") REFERENCES "public"."triage_call"("id") ON DELETE restrict,
	CONSTRAINT "m19_triage_paper_reentry_pair" CHECK (("reentered_at" IS NOT NULL) = ("linked_triage_call_id" IS NOT NULL)),
	CONSTRAINT "m19_triage_paper_reentry_window" CHECK ("shift_ends_at" > "shift_starts_at")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "triage_paper_reentry_worklist_org_idx" ON "triage_paper_reentry_worklist" ("organization_id","expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "triage_paper_reentry_worklist_outage_idx" ON "triage_paper_reentry_worklist" ("outage_window_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "triage_paper_reentry_worklist_outstanding_idx" ON "triage_paper_reentry_worklist" ("organization_id","expires_at") WHERE reentered_at IS NULL;
