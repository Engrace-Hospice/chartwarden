-- M32 AI Platform §3.1/§3.2 — the twenty-one enum types and ELEVEN of the module's thirteen owned
-- tables. The two partitioned tables (`ai_invocation`, `ai_token_ledger`) land in 0114 and 0115, each in
-- its OWN file: check-ddl-legality rule 1 derives one partition column per FILE and then requires every
-- UNIQUE/PK in that file to contain it, and the eleven tables here are keyed on `id` alone. RLS, grants,
-- the M4 write-audit triggers and the §3.5 immutability triggers land in 0116.
--
-- TENANCY (ARCH-011 / ADR-0010), the shape of the whole module:
--   • SIX PLATFORM-SHARED tables carry no organization_id BY DESIGN — ai_capability,
--     ai_capability_lifecycle_event, ai_capability_calibration, ai_model_backend, ai_prompt_template and
--     ai_evaluation_run. The governance surface is read-all within any tenant and written only by
--     wardenx_admin (System Design §4.6; the M38 code_system / M22 form_template / M21 supply_item
--     precedent), because a tenant must be able to SEE which capabilities exist in order to opt in to
--     one — and because a per-tenant copy of the model registry would let two tenants disagree about
--     which model version answered a question. All six are listed in check-tenancy.ts's NON_ORG_SCOPED
--     set with that justification.
--   • FOUR TENANT-SCOPED tables here carry organization_id NOT NULL on canonical app.org_id RLS:
--     ai_tenant_opt_in_record, ai_clinician_opt_out, ai_hallucination_report, ai_routing_override.
--   • ONE MIXED table: ai_kill_switch_state, whose organization_id is NULLABLE and whose NULL row is a
--     PLATFORM-WIDE kill. Its RLS (0116) splits by COMMAND rather than using one FOR ALL policy, so a
--     tenant READS the platform row and can never write one.
--
-- THE THREE-COLUMN RULE BEYOND §3.2: `ai_hallucination_report` additionally carries provider_entity_id
-- NOT NULL + location_id nullable (and `ai_invocation` likewise, in 0114). §3.2 gives neither table more
-- than organization_id; ARCH-011 requires the pair on a PHI-bearing table and architecture wins over a
-- module spec. The hallucination report is PHI-bearing in the way that matters most — its
-- `reporter_narrative_cipher` is a clinician writing down what the model invented ABOUT A PATIENT — even
-- though it deliberately has no patient_id column (the tie to a chart is `invocation_id`; a patient
-- column would create a second path by which a fabrication report becomes part of that patient's record).
--
-- THE TWO CHECKS ON `ai_model_backend` ARE THE D19/D17 CONTROL and the reason the registry is a table
-- rather than a config file: a `cloud` backend cannot be INSERTED without a BAA reference and
-- `zdr_status = 'enabled'`, and a `local` backend cannot be inserted without license terms and a stored
-- artifact. "We sent PHI to a vendor with no BAA" is therefore a failed INSERT, not a review finding.
--
-- ONE DEVIATION FROM §3.2, AND IT IS FORCED — `ai_routing_override`. §3.2.13 specifies a partial unique
-- index `(organization_id, capability_id) WHERE expires_at IS NULL OR expires_at > now()`. PostgreSQL
-- CANNOT CREATE IT: an index predicate may call only IMMUTABLE functions and `now()` is STABLE, so the
-- migration would fail with "functions in index predicate must be marked IMMUTABLE" — and even if it
-- were legal, an index predicate is evaluated at WRITE time and never re-evaluated, so a row that
-- expired yesterday would still hold the slot today. The rule a database can actually hold is a
-- no-overlap EXCLUDE over the validity WINDOW (btree_gist for the uuid equality opclass; the M17
-- visit_no_overlap / M26 cap_period_no_overlap / M24 precedent). It is strictly stronger than the spec's
-- intent: an open-ended override is `tstzrange(effective_at, NULL)`, unbounded above, so two live
-- overrides for one (org, capability) overlap and the second is refused — and a scheduled future
-- override can no longer silently collide with the current one.
--
-- §3.2.1's `ai_capability_lifecycle_check` CHECK is deliberately NOT created: `lifecycle_state` IS the
-- `ai_capability_lifecycle_state` enum, so the CHECK restates the column type — and a redundant value
-- list is a drift hazard rather than a belt-and-braces (add a ninth state to the enum and the CHECK
-- silently refuses every row carrying it). Same reasoning wherever §3.2 repeats an enum as a CHECK. The
-- vocabularies §3.2 spells INLINE on text columns (`zdr_status`, `override_reason`,
-- `triage_disposition`, `routing_preference_snapshot`) are NOT enums in §3.1, so they stay text + a
-- value CHECK — adding pg types the spec never declared would be this module inventing DDL.
--
-- CROSS-MODULE FK POLICY: organization / provider_entity / location (M1 spine) and the intra-M32 parents
-- (`ai_capability`, `ai_model_backend`, both unpartitioned) carry REAL FKs. Every M2 membership id
-- (`actor_membership_id`, `org_admin_membership_id`, `reporter_membership_id`, …) and every reference to
-- the partitioned `ai_invocation` is a LOGICAL uuid, validated at the write boundary — a real FK to a
-- partitioned table would have to name its full composite key.
CREATE EXTENSION IF NOT EXISTS btree_gist;--> statement-breakpoint

-- ============================================================================================
-- §3.1 — the twenty-one enum types.
-- ============================================================================================
CREATE TYPE "public"."ai_capability_lifecycle_state" AS ENUM('PROPOSED', 'DESIGN_REVIEW', 'EVALUATION', 'PILOT', 'APPROVED', 'MONITORING', 'DEPRECATED', 'RETIRED');--> statement-breakpoint
CREATE TYPE "public"."ai_capability_risk_tier" AS ENUM('high', 'medium', 'low');--> statement-breakpoint
CREATE TYPE "public"."ai_capability_owning_role" AS ENUM('ai_safety_owner', 'clinical_reviewer', 'ai_engineer', 'privacy_officer');--> statement-breakpoint
CREATE TYPE "public"."ai_fda_samd_classification" AS ENUM('class_i', 'class_ii', 'class_iii', 'class_iv', 'not_samd');--> statement-breakpoint
CREATE TYPE "public"."ai_model_backend_kind" AS ENUM('cloud', 'local');--> statement-breakpoint
CREATE TYPE "public"."ai_backend_health_status" AS ENUM('healthy', 'degraded', 'unhealthy', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."ai_prompt_template_status" AS ENUM('active', 'deprecated', 'archived');--> statement-breakpoint
CREATE TYPE "public"."ai_tenant_opt_in_status" AS ENUM('active', 'paused', 'opted_out');--> statement-breakpoint
CREATE TYPE "public"."ai_invocation_status" AS ENUM('completed', 'failed', 'timed_out', 'killed', 'capability_unavailable');--> statement-breakpoint
CREATE TYPE "public"."ai_invocation_hitl_outcome" AS ENUM('accepted', 'edited', 'rejected', 'pending', 'not_applicable');--> statement-breakpoint
CREATE TYPE "public"."ai_routing_decision" AS ENUM('primary', 'fallback_1', 'fallback_2');--> statement-breakpoint
CREATE TYPE "public"."ai_routing_reason" AS ENUM('default', 'tenant_override', 'kill_switch_fallback', 'vendor_outage_fallback', 'cost_cap_fallback');--> statement-breakpoint
CREATE TYPE "public"."ai_hallucination_severity" AS ENUM('critical', 'high', 'medium', 'low');--> statement-breakpoint
CREATE TYPE "public"."ai_hallucination_kind" AS ENUM('fabricated_medication', 'misattributed_symptom', 'fake_diagnosis', 'fabricated_quote', 'misquoted_patient', 'wrong_dose', 'fake_clinical_recommendation', 'other');--> statement-breakpoint
CREATE TYPE "public"."ai_hallucination_triage_status" AS ENUM('open', 'investigating', 'root_cause_identified', 'mitigated', 'closed', 'escalated_to_clinical_safety');--> statement-breakpoint
CREATE TYPE "public"."ai_evaluation_run_stage" AS ENUM('stage_3_evaluation', 'stage_4_pilot', 'reapproval', 'drift_response', 'post_incident');--> statement-breakpoint
CREATE TYPE "public"."ai_evaluation_run_status" AS ENUM('pending', 'in_progress', 'passed', 'failed', 'aborted');--> statement-breakpoint
CREATE TYPE "public"."ai_evaluation_run_decision" AS ENUM('approve_for_pilot', 'approve_for_ga', 'reject', 'recalibrate_thresholds', 'no_decision');--> statement-breakpoint
CREATE TYPE "public"."ai_kill_switch_reason" AS ENUM('sev1_hallucination', 'sev2_hallucination', 'cost_cap_reached', 'vendor_outage_exceeded_sla', 'prompt_injection_detected', 'manual_safety_pause', 'misuse_detected', 'bias_drift_severe', 'lifecycle_demotion');--> statement-breakpoint
CREATE TYPE "public"."ai_kill_switch_activation_actor_kind" AS ENUM('ai_safety_owner', 'incident_commander', 'automated_cost_watch', 'automated_drift_monitor', 'automated_vendor_health_monitor', 'automated_lifecycle_demotion');--> statement-breakpoint
CREATE TYPE "public"."ai_lifecycle_approval_kind" AS ENUM('stage_1_proposal', 'stage_2_design_review', 'stage_3_evaluation', 'stage_4_pilot', 'stage_5_ga', 'reapproval', 'deprecation', 'retirement', 'incident_demotion');--> statement-breakpoint

-- ============================================================================================
-- §3.2.1 `ai_capability` — the governance registry (PLATFORM-SHARED).
-- `default_backend_key` / `allowed_backend_keys` / `fallback_chain_keys` are KEYS, not FKs (§3.2.1):
-- `ai_model_backend` is an independent registry rewritten by vendor-version bumps, and a hard FK would
-- make retiring a backend require rewriting every capability row that ever named it.
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "ai_capability" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"capability_key" text NOT NULL,
	"display_name" text NOT NULL,
	"description" text NOT NULL,
	"risk_tier" "ai_capability_risk_tier" NOT NULL,
	"lifecycle_state" "ai_capability_lifecycle_state" DEFAULT 'PROPOSED' NOT NULL,
	"default_backend_key" text NOT NULL,
	"allowed_backend_keys" jsonb NOT NULL,
	"fallback_chain_keys" jsonb NOT NULL,
	"tenant_override_allowed" boolean DEFAULT false NOT NULL,
	"tenant_opt_in_required" boolean DEFAULT true NOT NULL,
	"clinician_opt_out_supported" boolean DEFAULT true NOT NULL,
	"clinical_review_required" boolean DEFAULT false NOT NULL,
	"owning_role" "ai_capability_owning_role" DEFAULT 'ai_safety_owner' NOT NULL,
	"marketing_disclosure_template" text,
	"fda_samd_classification" "ai_fda_samd_classification" DEFAULT 'not_samd' NOT NULL,
	"current_prompt_template_key" text,
	"first_approved_at" timestamp with time zone,
	"last_reapproved_at" timestamp with time zone,
	"next_reapproval_due_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_capability_pkey" PRIMARY KEY ("id"),
	-- A capability cannot be generally available with nothing to execute. Without this the failure
	-- surfaces as a null-deref at the first real invocation instead of at the promotion that caused it.
	CONSTRAINT "ai_capability_approved_has_template" CHECK ("lifecycle_state" NOT IN ('APPROVED','MONITORING') OR "current_prompt_template_key" IS NOT NULL)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ai_capability_key_idx" ON "ai_capability" ("capability_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_capability_lifecycle_idx" ON "ai_capability" ("lifecycle_state");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_capability_risk_tier_idx" ON "ai_capability" ("risk_tier");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_capability_reapproval_due_idx" ON "ai_capability" ("next_reapproval_due_at") WHERE lifecycle_state IN ('APPROVED','MONITORING');--> statement-breakpoint

-- ============================================================================================
-- §3.2.2 `ai_capability_lifecycle_event` — the append-only D2 approval ledger (PLATFORM-SHARED).
-- `from_state` is NULLABLE for exactly one row per capability: the initial arrival at PROPOSED has no
-- predecessor, and NOT NULL would force the first row to invent a fictional prior state.
-- `approval_kind` names the GATE, not the outcome — a stage-3 evaluation that REJECTS is still
-- `stage_3_evaluation`, and an edge is keyed on the (from, to, kind) TRIPLE.
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "ai_capability_lifecycle_event" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"capability_id" uuid NOT NULL,
	"from_state" "ai_capability_lifecycle_state",
	"to_state" "ai_capability_lifecycle_state" NOT NULL,
	"actor_membership_id" uuid NOT NULL,
	"actor_role" "ai_capability_owning_role" NOT NULL,
	"approval_kind" "ai_lifecycle_approval_kind" NOT NULL,
	"reason" text NOT NULL,
	"rationale_text" text NOT NULL,
	"linked_evaluation_run_id" uuid,
	"stage_artifacts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"transitioned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_cap_lifecycle_event_pkey" PRIMARY KEY ("id"),
	CONSTRAINT "ai_cap_lifecycle_capability_id_fk" FOREIGN KEY ("capability_id") REFERENCES "public"."ai_capability"("id") ON DELETE restrict
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_cap_lifecycle_capability_idx" ON "ai_capability_lifecycle_event" ("capability_id","transitioned_at" DESC);--> statement-breakpoint

-- ============================================================================================
-- §3.2.3 `ai_capability_calibration` — thresholds + the drift baseline (PLATFORM-SHARED).
-- Keyed on (capability, BACKEND) and not on capability alone: the same capability behaves differently on
-- a cloud frontier model and on a local 3B, which is exactly the "calibration trade-off" §5.3 makes the
-- tenant acknowledge. One threshold set per capability would apply the cloud baseline to the local route
-- and the drift monitor would then fire continuously on a backend working as specified.
-- The partial unique index is what makes "one CURRENT calibration per (capability, backend)" a fact;
-- unconditional, it would forbid history instead.
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "ai_capability_calibration" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"capability_id" uuid NOT NULL,
	"backend_key" text NOT NULL,
	"thresholds" jsonb NOT NULL,
	"baseline_metrics" jsonb NOT NULL,
	"baseline_set_at" timestamp with time zone NOT NULL,
	"baseline_evaluation_run_id" uuid NOT NULL,
	"is_current" boolean DEFAULT true NOT NULL,
	"superseded_reason" text,
	"superseded_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"superseded_at" timestamp with time zone,
	CONSTRAINT "ai_cap_calibration_pkey" PRIMARY KEY ("id"),
	CONSTRAINT "ai_cap_calib_capability_id_fk" FOREIGN KEY ("capability_id") REFERENCES "public"."ai_capability"("id") ON DELETE restrict
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ai_cap_calib_current_per_backend_idx" ON "ai_capability_calibration" ("capability_id","backend_key") WHERE is_current = true;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_cap_calib_history_idx" ON "ai_capability_calibration" ("capability_id","backend_key","created_at" DESC);--> statement-breakpoint

-- ============================================================================================
-- §3.2.4 `ai_model_backend` — the version-pinned model registry (PLATFORM-SHARED).
-- `model_version_pin` is never 'latest': a moving pin makes every ai_invocation row's provenance a lie.
-- That rule is enforced at the registration route rather than by a CHECK because the illegal value is a
-- CLASS ('latest', 'stable', an unversioned alias), not a literal.
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "ai_model_backend" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"backend_key" text NOT NULL,
	"kind" "ai_model_backend_kind" NOT NULL,
	"vendor" text NOT NULL,
	"model_family" text NOT NULL,
	"model_version_pin" text NOT NULL,
	"supported_modalities" jsonb NOT NULL,
	"context_window_tokens" integer NOT NULL,
	"max_output_tokens" integer NOT NULL,
	"supported_features" jsonb NOT NULL,
	"baa_reference" text,
	"zdr_status" text DEFAULT 'not_applicable' NOT NULL,
	"license_terms" text,
	"artifact_storage_ref" text,
	"artifact_checksum" text,
	"health_endpoint" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"deprecation_reason" text,
	"first_registered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_health_check_at" timestamp with time zone,
	"last_health_status" "ai_backend_health_status" DEFAULT 'unknown',
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_model_backend_pkey" PRIMARY KEY ("id"),
	CONSTRAINT "ai_backend_zdr_status_check" CHECK ("zdr_status" IN ('enabled','not_applicable','disabled')),
	-- D19: no cloud route without a BAA and ZDR on.
	CONSTRAINT "ai_backend_cloud_baa_check" CHECK ("kind" = 'local' OR ("baa_reference" IS NOT NULL AND "zdr_status" = 'enabled')),
	-- D17: no local route without license terms and a stored artifact.
	CONSTRAINT "ai_backend_local_license_check" CHECK ("kind" = 'cloud' OR ("license_terms" IS NOT NULL AND "artifact_storage_ref" IS NOT NULL))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ai_backend_key_idx" ON "ai_model_backend" ("backend_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_backend_active_idx" ON "ai_model_backend" ("is_active") WHERE is_active = true;--> statement-breakpoint

-- ============================================================================================
-- §3.2.5 `ai_prompt_template` — the versioned prompt registry + the D18 prohibited-zone key
-- (PLATFORM-SHARED). The prompt TEXT is not in the row: `template_filesystem_ref` +
-- `template_content_hash` (SHA-256, hence the length-64 CHECK) point at a file that is reviewed, diffed
-- and signed off in version control like any other code. A prompt pasted into a database column is a
-- prompt nobody reviewed. The two prefix columns are OPEN vocabularies on text, deliberately un-CHECKed:
-- a new capability introduces a new target, and a value list would mean a prohibited-zone key could not
-- be added without a migration.
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "ai_prompt_template" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"template_key" text NOT NULL,
	"capability_key" text NOT NULL,
	"version" integer NOT NULL,
	"template_filesystem_ref" text NOT NULL,
	"template_content_hash" text NOT NULL,
	"compatible_backend_keys" jsonb NOT NULL,
	"input_schema_ref" text NOT NULL,
	"output_schema_ref" text NOT NULL,
	"output_entity_target_prefix" text NOT NULL,
	"output_type_prefix" text NOT NULL,
	"status" "ai_prompt_template_status" DEFAULT 'active' NOT NULL,
	"created_by_membership_id" uuid NOT NULL,
	"approved_by_membership_id" uuid,
	"clinical_reviewer_attestation" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"approved_at" timestamp with time zone,
	"superseded_at" timestamp with time zone,
	"deprecated_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	CONSTRAINT "ai_prompt_template_pkey" PRIMARY KEY ("id"),
	CONSTRAINT "ai_prompt_template_content_hash_check" CHECK (length("template_content_hash") = 64)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ai_prompt_template_key_idx" ON "ai_prompt_template" ("template_key");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ai_prompt_template_cap_version_idx" ON "ai_prompt_template" ("capability_key","version");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_prompt_template_active_idx" ON "ai_prompt_template" ("capability_key","status") WHERE status = 'active';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_prompt_template_targeting_idx" ON "ai_prompt_template" ("output_entity_target_prefix","status") WHERE status = 'active';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_prompt_template_output_type_idx" ON "ai_prompt_template" ("output_type_prefix","status") WHERE status = 'active';--> statement-breakpoint

-- ============================================================================================
-- §3.2.11 `ai_evaluation_run` — governance evaluation evidence (PLATFORM-SHARED).
-- `mlflow_run_id` + `dataset_version_ref` are the row's purpose: the metrics live in MLflow and the
-- dataset in DVC, and WardenX stores the POINTERS plus the human decision taken on them. `decision`
-- defaults to `no_decision` and is NOT NULL so a finished-but-unruled evaluation is visibly undecided
-- rather than implicitly approved.
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "ai_evaluation_run" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"capability_id" uuid NOT NULL,
	"backend_id" uuid NOT NULL,
	"dataset_version_ref" text NOT NULL,
	"mlflow_run_id" text NOT NULL,
	"stage" "ai_evaluation_run_stage" NOT NULL,
	"summary_metrics" jsonb NOT NULL,
	"status" "ai_evaluation_run_status" DEFAULT 'pending' NOT NULL,
	"initiated_by_membership_id" uuid NOT NULL,
	"decision" "ai_evaluation_run_decision" DEFAULT 'no_decision' NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_evaluation_run_pkey" PRIMARY KEY ("id"),
	CONSTRAINT "ai_eval_run_capability_id_fk" FOREIGN KEY ("capability_id") REFERENCES "public"."ai_capability"("id") ON DELETE restrict,
	CONSTRAINT "ai_eval_run_backend_id_fk" FOREIGN KEY ("backend_id") REFERENCES "public"."ai_model_backend"("id") ON DELETE restrict
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_eval_run_cap_backend_idx" ON "ai_evaluation_run" ("capability_id","backend_id","started_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_eval_run_status_idx" ON "ai_evaluation_run" ("status") WHERE status IN ('pending','in_progress');--> statement-breakpoint

-- ============================================================================================
-- §3.2.6 `ai_tenant_opt_in_record` — W4's tenant decision (TENANT-SCOPED).
-- The default is `opted_out` and that is the design: the row's EXISTENCE is not consent — it can be
-- created the moment an admin opens the page — the STATUS is. A schema where the row means yes makes
-- every partially-completed workflow an accidental authorization.
-- `disclosure_acknowledgments` / `calibration_trade_off_acknowledged` / `routing_preference_snapshot`
-- are frozen EVIDENCE, not settings: they record what was actually shown and which routing posture was
-- in force, so "they agreed to today's wording" can never be substituted for what they agreed to then.
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "ai_tenant_opt_in_record" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"capability_id" uuid NOT NULL,
	"status" "ai_tenant_opt_in_status" DEFAULT 'opted_out' NOT NULL,
	"org_admin_membership_id" uuid NOT NULL,
	"disclosure_acknowledgments" jsonb NOT NULL,
	"routing_preference_snapshot" text NOT NULL,
	"calibration_trade_off_acknowledged" text,
	"pilot_enrollment" boolean DEFAULT false NOT NULL,
	"opted_in_at" timestamp with time zone,
	"paused_at" timestamp with time zone,
	"paused_reason" text,
	"opted_out_at" timestamp with time zone,
	"opted_out_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_tenant_opt_in_pkey" PRIMARY KEY ("id"),
	CONSTRAINT "ai_tenant_opt_in_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "ai_tenant_opt_in_capability_id_fk" FOREIGN KEY ("capability_id") REFERENCES "public"."ai_capability"("id") ON DELETE restrict,
	CONSTRAINT "ai_tenant_opt_in_routing_pref_check" CHECK ("routing_preference_snapshot" IN ('prefer_cloud','prefer_local','cloud_only','local_only')),
	-- `active` is the one status that authorizes an invocation, so it must carry the instant it was
	-- granted; an active opt-in with no timestamp cannot be reconciled against the invocation ledger.
	CONSTRAINT "ai_tenant_opt_in_active_has_timestamp" CHECK ("status" <> 'active' OR "opted_in_at" IS NOT NULL)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ai_tenant_opt_in_org_cap_idx" ON "ai_tenant_opt_in_record" ("organization_id","capability_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_tenant_opt_in_active_idx" ON "ai_tenant_opt_in_record" ("organization_id","status") WHERE status = 'active';--> statement-breakpoint

-- ============================================================================================
-- §3.2.7 `ai_clinician_opt_out` — §5.4's individual refusal (TENANT-SCOPED).
-- Keyed on the MEMBERSHIP, not the user: the same human working for two agencies may reasonably decide
-- differently for each, and a user-keyed row would leak one tenant's decision into the other.
-- The unique index is PARTIAL — one LIVE opt-out per (membership, capability), history unconstrained.
-- Unconditional, it would force a clinician who opts out, reverts and opts out again to overwrite the
-- record of the first refusal, which is the record that explains why three months of their notes carry
-- no AI provenance.
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "ai_clinician_opt_out" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"capability_id" uuid NOT NULL,
	"opted_out" boolean DEFAULT true NOT NULL,
	"reason" text,
	"opted_out_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reverted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_clinician_opt_out_pkey" PRIMARY KEY ("id"),
	CONSTRAINT "ai_clin_optout_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "ai_clin_optout_capability_id_fk" FOREIGN KEY ("capability_id") REFERENCES "public"."ai_capability"("id") ON DELETE restrict
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ai_clin_optout_member_cap_idx" ON "ai_clinician_opt_out" ("membership_id","capability_id") WHERE opted_out = true AND reverted_at IS NULL;--> statement-breakpoint

-- ============================================================================================
-- §3.2.10 `ai_hallucination_report` — W5's entry point (TENANT-SCOPED, PHI-bearing narrative).
-- `invocation_id` IS NULLABLE ON PURPOSE, and it is nullable for the reason that makes the workflow
-- work: the clinician sees a wrong sentence, not a correlation id. Requiring the invocation would refuse
-- exactly the reports that matter most — the ones where provenance is already broken. Logical uuid, not
-- an FK, because `ai_invocation` is partitioned.
-- provider_entity_id NOT NULL + location_id per ARCH-011 (see the file header).
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "ai_hallucination_report" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"location_id" uuid,
	"invocation_id" uuid,
	"capability_id" uuid NOT NULL,
	"reporter_membership_id" uuid NOT NULL,
	"reporter_role" text NOT NULL,
	"severity" "ai_hallucination_severity" NOT NULL,
	"hallucination_kind" "ai_hallucination_kind" NOT NULL,
	"reporter_narrative_cipher" bytea NOT NULL,
	"triage_status" "ai_hallucination_triage_status" DEFAULT 'open' NOT NULL,
	"triage_owner_membership_id" uuid,
	"triage_disposition" text,
	"mitigation_action_ref" text,
	"reported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"triaged_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_hallucination_report_pkey" PRIMARY KEY ("id"),
	CONSTRAINT "ai_halluc_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "ai_halluc_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict,
	CONSTRAINT "ai_halluc_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict,
	CONSTRAINT "ai_halluc_capability_id_fk" FOREIGN KEY ("capability_id") REFERENCES "public"."ai_capability"("id") ON DELETE restrict,
	CONSTRAINT "ai_hallucination_disposition_check" CHECK ("triage_disposition" IS NULL OR "triage_disposition" IN ('prompt_iteration_required','model_rollback_required','edge_case_acknowledged','false_alarm'))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_hallucination_org_reported_idx" ON "ai_hallucination_report" ("organization_id","reported_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_hallucination_cap_reported_idx" ON "ai_hallucination_report" ("capability_id","reported_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_hallucination_open_triage_idx" ON "ai_hallucination_report" ("triage_status","severity") WHERE triage_status IN ('open','investigating');--> statement-breakpoint

-- ============================================================================================
-- §3.2.12 `ai_kill_switch_state` — W3's switch (MIXED SCOPE: organization_id NULLABLE, NULL = a
-- platform-wide kill).
-- TWO PARTIAL UNIQUE INDEXES, NOT ONE, and the second is not redundant: NULLs are DISTINCT in a
-- PostgreSQL unique index, so `(organization_id, capability_id)` constrains nothing at all for platform
-- rows — two platform-wide kills for one capability would both be accepted and deactivating one would
-- read as "the switch is off".
-- `active` is the switch, never row existence: a deactivated kill keeps its row with attribution on BOTH
-- sides, because the incident record of a SEV-1 pause is exactly what a post-mortem reads.
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "ai_kill_switch_state" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid,
	"capability_id" uuid NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"reason" "ai_kill_switch_reason",
	"activation_actor_kind" "ai_kill_switch_activation_actor_kind",
	"activation_actor_membership_id" uuid,
	"activation_message" text,
	"activated_at" timestamp with time zone,
	"deactivation_actor_kind" "ai_kill_switch_activation_actor_kind",
	"deactivation_actor_membership_id" uuid,
	"deactivation_message" text,
	"deactivated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_kill_switch_state_pkey" PRIMARY KEY ("id"),
	CONSTRAINT "ai_kill_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "ai_kill_capability_id_fk" FOREIGN KEY ("capability_id") REFERENCES "public"."ai_capability"("id") ON DELETE restrict,
	-- An ACTIVE kill must say who turned it on and why; an unattributed platform-wide stop is not an
	-- incident record, and the automated actor kinds exist precisely so a machine trip is still named.
	CONSTRAINT "ai_kill_active_attributed" CHECK ("active" = false OR ("reason" IS NOT NULL AND "activation_actor_kind" IS NOT NULL AND "activated_at" IS NOT NULL))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ai_kill_org_cap_idx" ON "ai_kill_switch_state" ("organization_id","capability_id") WHERE organization_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ai_kill_platform_cap_idx" ON "ai_kill_switch_state" ("capability_id") WHERE organization_id IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_kill_active_idx" ON "ai_kill_switch_state" ("capability_id","organization_id") WHERE active = true;--> statement-breakpoint

-- ============================================================================================
-- §3.2.13 `ai_routing_override` — W8's local-only sovereignty override (TENANT-SCOPED).
-- See the file header for why the spec's `WHERE ... > now()` partial unique index is replaced by the
-- no-overlap EXCLUDE below (index predicates must be IMMUTABLE; `now()` is STABLE).
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "ai_routing_override" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"capability_id" uuid NOT NULL,
	"backend_key_preference" text NOT NULL,
	"override_reason" text NOT NULL,
	"set_by_membership_id" uuid NOT NULL,
	"effective_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_routing_override_pkey" PRIMARY KEY ("id"),
	CONSTRAINT "ai_routing_override_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "ai_routing_override_capability_id_fk" FOREIGN KEY ("capability_id") REFERENCES "public"."ai_capability"("id") ON DELETE restrict,
	CONSTRAINT "ai_routing_override_reason_check" CHECK ("override_reason" IN ('tenant_sovereignty','tenant_cost','tenant_pilot','fallback_after_outage')),
	-- An override that expires before it takes effect would otherwise sit in the table looking live.
	CONSTRAINT "ai_routing_override_window_check" CHECK ("expires_at" IS NULL OR "expires_at" > "effective_at"),
	CONSTRAINT "ai_routing_override_no_overlap" EXCLUDE USING gist ("organization_id" WITH =, "capability_id" WITH =, tstzrange("effective_at", "expires_at") WITH &&)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_routing_override_org_cap_idx" ON "ai_routing_override" ("organization_id","capability_id","effective_at" DESC);
