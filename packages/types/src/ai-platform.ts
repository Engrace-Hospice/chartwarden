// @wardenx/types — Module 32 (AI Platform) leaf contracts (M32-T01).
//
// Per ADR-0005 D1/D2 the cross-module CONTRACTS live in this leaf package, so every downstream consumer
// (M8's HearthNote Layer 2, M14's IDG packet polish, M16's bereavement risk narrative, M19's protocol
// suggestion + hospitalization risk, M22's DocLens quartet, M25's denial prediction, and the
// M12/M13/M18/M21/M27/M28 boot validators that query the AI-prohibited zone) imports them with NO
// `dependsOn` edge. M32 never imports another module's feature package.
//
// WHAT T01 SHIPS. The type-level surface every later M32 task builds on: the §3.1 pgEnum value mirrors,
// the vocabularies §3.2 spells inline on `text` columns, the §2.2 lifecycle vocabulary + the
// consumer-facing posture each state implies, the §2.3/§2.4 Phase-1 registration ROW TYPES (the DATA
// lives in `packages/ai-platform` — a leaf type package must not carry a model registry), the §3.3
// tenancy scope + §3.4 audit denylist + ADR-0004 retention class + §3.5 immutability rule + §3.6 cipher
// columns per owned table (the M4 trigger arguments M32-T02 passes), the §3.7 eraser data-class names,
// and the §2.2/W9 `capability_unavailable` envelope every deny-stub returns.
//
// WHAT T01 DELIBERATELY DOES NOT SHIP. The twelve §4.2 published seam interfaces (M32-T08 / the plan's
// T06), the §2.5 per-capability TypeBox input/output schemas (spec T07), the §4.11 outbox catalog and
// §4.9 alert payloads (plan T07). Two of the twelve seams — `ProtocolSuggestionProvider` and
// `HospitalizationRiskProvider` — ALREADY exist in `./oncall` because M19-T01 declared them as forward
// seams; M32 consumes those declarations rather than re-declaring them (a second declaration would be a
// TS2308 collision under this package's wholesale `export *`).
//
// NAMING: every exported symbol carries an `Ai` / `AI_` / `M32_` prefix. `@wardenx/types` is re-exported
// wholesale from `./index.ts`, so a bare `RiskTier` / `LifecycleState` / `BackendKind` would collide the
// day another module wants the same word (the M14 `IdgDecisionPayload` and M19 `TriageDisposition`
// precedents). `Ai` — not `AI` — matches the repo's PascalCase convention for type names.
//
// PHASE-1 POSTURE (Wave H plan, "M32 — capability shell only"). `ai.full` is OFF for every tenant, so
// the lifecycle state is NECESSARY BUT NOT SUFFICIENT: a capability at `APPROVED` still deny-stubs
// because the outermost gate is the flag, not the registry. See `AI_FULL_FLAG` below.

// ── Leaf-safe shared id aliases (single definition site elsewhere; imported for internal use only so
//    the package surface stays unambiguous under `export *` — re-exporting would be a TS2308 collision)
import type { OrgId, PatientId } from "./admission";
import type { IsoInstant, MembershipId } from "./care-plan";

// ── M32-owned id aliases (mirror the §3.2 uuid PKs; packages/types cannot import @wardenx/db) ─────────

export type AiCapabilityId = string;
export type AiCapabilityLifecycleEventId = string;
export type AiCapabilityCalibrationId = string;
export type AiModelBackendId = string;
export type AiPromptTemplateId = string;
export type AiTenantOptInRecordId = string;
export type AiClinicianOptOutId = string;
export type AiInvocationId = string;
export type AiTokenLedgerId = string;
export type AiHallucinationReportId = string;
export type AiEvaluationRunId = string;
export type AiKillSwitchStateId = string;
export type AiRoutingOverrideId = string;

/** Soft refs M32 stores but does not own: the MLflow run holding the per-example evaluation artifacts
 *  (D10 — the DB row is the summary, MLflow is the artifact backend) and the outbox correlation id the
 *  consumer module threaded through its own request. */
export type MlflowRunId = string;
export type AiConsumerCorrelationId = string;

// ── §3.1 pgEnum value mirrors (kept in lock-step with `packages/db/src/enums.ts` by the M32-T01
//    `apps/backend/__tests__/ai-platform-contracts.test.ts` drift guard — a comment keeps nothing in
//    lock-step, the `satisfies`-checked mirror table does) ──────────────────────────────────────────

/** `ai_capability_lifecycle_state` — D2's eight-state governance FSM. */
export type AiCapabilityLifecycleState =
  | "PROPOSED"
  | "DESIGN_REVIEW"
  | "EVALUATION"
  | "PILOT"
  | "APPROVED"
  | "MONITORING"
  | "DEPRECATED"
  | "RETIRED";

/** The eight in PROMOTION order. `packages/ai-platform`'s state machine is the authority on which
 *  EDGES are legal — this tuple is only the vocabulary, and reading it as a linear path would miss the
 *  two rejection edges and the two D16 demotion edges. */
export const AI_CAPABILITY_LIFECYCLE_STATES = [
  "PROPOSED",
  "DESIGN_REVIEW",
  "EVALUATION",
  "PILOT",
  "APPROVED",
  "MONITORING",
  "DEPRECATED",
  "RETIRED",
] as const satisfies readonly AiCapabilityLifecycleState[];

/** `ai_capability_risk_tier` — AI Governance §4.2. */
export type AiCapabilityRiskTier = "high" | "medium" | "low";

/** `ai_capability_owning_role` — the four accountable governance roles. Doubles as
 *  `ai_capability_lifecycle_event.actor_role`. */
export type AiCapabilityOwningRole =
  | "ai_safety_owner"
  | "clinical_reviewer"
  | "ai_engineer"
  | "privacy_officer";

/** `ai_fda_samd_classification` — Software-as-a-Medical-Device posture; `not_samd` Phase 1. */
export type AiFdaSamdClassification =
  | "class_i"
  | "class_ii"
  | "class_iii"
  | "class_iv"
  | "not_samd";

/** `ai_model_backend_kind` — the D17/D19 fork that decides which opt-in gate applies. */
export type AiModelBackendKind = "cloud" | "local";

/** `ai_backend_health_status` — `unknown` (registered, never probed) is DISTINCT from `unhealthy`
 *  (answered badly). D17 gates a `local_only` opt-in on `green`/`healthy`, and a backend nobody has
 *  reached yet must not read as one that failed. */
export type AiBackendHealthStatus = "healthy" | "degraded" | "unhealthy" | "unknown";

/** `ai_prompt_template_status` — D3. Only `active` resolves through `AIPromptRegistry`. */
export type AiPromptTemplateStatus = "active" | "deprecated" | "archived";

/** `ai_tenant_opt_in_status` — §3.2.6 defaults to `opted_out`: the row's existence is not consent. */
export type AiTenantOptInStatus = "active" | "paused" | "opted_out";

/** `ai_invocation_status` — `capability_unavailable` is a RECORDED outcome, not an absent row. A gate
 *  refusal is itself the §164.528 evidence that no PHI left the platform. */
export type AiInvocationStatus =
  | "completed"
  | "failed"
  | "timed_out"
  | "killed"
  | "capability_unavailable";

/** `ai_invocation_hitl_outcome` — the human decision. `pending` is the insert default and the only
 *  column §3.5's immutability trigger lets a consumer update after the fact (`recordHitlOutcome`). */
export type AiInvocationHitlOutcome =
  | "accepted"
  | "edited"
  | "rejected"
  | "pending"
  | "not_applicable";

/** `ai_routing_decision` — WHICH link of the capability's chain served the call. */
export type AiRoutingDecision = "primary" | "fallback_1" | "fallback_2";

/** `ai_routing_reason` — WHY that link served it. `cost_cap_fallback` (§3.1, absent from the §2.1 ERD)
 *  is what makes D7's hard-cap fallback distinguishable from a vendor outage in the ledger. */
export type AiRoutingReason =
  | "default"
  | "tenant_override"
  | "kill_switch_fallback"
  | "vendor_outage_fallback"
  | "cost_cap_fallback";

/** `ai_hallucination_severity` — `critical` is the D16 SEV-1 trigger. */
export type AiHallucinationSeverity = "critical" | "high" | "medium" | "low";

/** `ai_hallucination_kind` — §3.1 adds `fake_clinical_recommendation` beyond the §2.1 ERD list. */
export type AiHallucinationKind =
  | "fabricated_medication"
  | "misattributed_symptom"
  | "fake_diagnosis"
  | "fabricated_quote"
  | "misquoted_patient"
  | "wrong_dose"
  | "fake_clinical_recommendation"
  | "other";

/** `ai_hallucination_triage_status` — D9's queue. `escalated_to_clinical_safety` is terminal FOR M32
 *  and open for the clinical-safety committee; it is not `closed`. */
export type AiHallucinationTriageStatus =
  | "open"
  | "investigating"
  | "root_cause_identified"
  | "mitigated"
  | "closed"
  | "escalated_to_clinical_safety";

/** The two statuses §3.2.10's `openTriageIdx` partial index covers — the triage queue's working set. */
export const AI_HALLUCINATION_OPEN_TRIAGE_STATUSES = [
  "open",
  "investigating",
] as const satisfies readonly AiHallucinationTriageStatus[];

/** `ai_evaluation_run_stage` — which governance gate the run is evidence for (D10). */
export type AiEvaluationRunStage =
  | "stage_3_evaluation"
  | "stage_4_pilot"
  | "reapproval"
  | "drift_response"
  | "post_incident";

/** `ai_evaluation_run_status` — the run's own lifecycle, distinct from its `decision`. */
export type AiEvaluationRunStatus = "pending" | "in_progress" | "passed" | "failed" | "aborted";

/** `ai_evaluation_run_decision` — `no_decision` (the §3.2.11 insert default) keeps a `pending` run from
 *  being forced to claim an outcome it has not reached. */
export type AiEvaluationRunDecision =
  | "approve_for_pilot"
  | "approve_for_ga"
  | "reject"
  | "recalibrate_thresholds"
  | "no_decision";

/** `ai_kill_switch_reason` — D8. `lifecycle_demotion` (§3.1, absent from the §2.1 ERD) is the reason
 *  the switch D16 trips automatically carries, so it stays distinguishable from the human ones. */
export type AiKillSwitchReason =
  | "sev1_hallucination"
  | "sev2_hallucination"
  | "cost_cap_reached"
  | "vendor_outage_exceeded_sla"
  | "prompt_injection_detected"
  | "manual_safety_pause"
  | "misuse_detected"
  | "bias_drift_severe"
  | "lifecycle_demotion";

/** `ai_kill_switch_activation_actor_kind` — reused for `deactivation_actor_kind`, which is why an
 *  automated kind has to stay expressible on the way OUT as well as the way in. */
export type AiKillSwitchActorKind =
  | "ai_safety_owner"
  | "incident_commander"
  | "automated_cost_watch"
  | "automated_drift_monitor"
  | "automated_vendor_health_monitor"
  | "automated_lifecycle_demotion";

/** The four `automated_*` kinds — the ones §3.2.12 allows with a NULL `activation_actor_membership_id`.
 *  A human kind without a membership id is a malformed row, not an automated activation. */
export const AI_KILL_SWITCH_AUTOMATED_ACTOR_KINDS = [
  "automated_cost_watch",
  "automated_drift_monitor",
  "automated_vendor_health_monitor",
  "automated_lifecycle_demotion",
] as const satisfies readonly AiKillSwitchActorKind[];

/** Which population a kill-switch row stops. `ai_kill_switch_state.organization_id IS NULL` is
 *  `platform`; a row carrying an org is `tenant` (§3.2.12, §4.9's alert discriminator). */
export type AiKillSwitchScope = "platform" | "tenant";

/** §4.9's `ai.kill_switch_activated` severity. `tenant` is not a lower SEV-1 — it is a DIFFERENT
 *  incident class: one agency paused a capability for itself, which pages nobody outside it. */
export type AiKillSwitchSeverity = "sev1" | "sev2" | "tenant";

/** §4.8's `ai:hallucination-triage-followup` job kinds (§4.9's `followUpAction` union) plus the
 *  `none` arm the union omits — a triage that closes a report as a false alarm has a follow-up
 *  decision to record, and modelling "no action" as an ABSENT action would make "we decided nothing
 *  was needed" indistinguishable from "the worker never ran". */
export type AiHallucinationFollowUpAction =
  | "deprecate_capability"
  | "raise_sev1"
  | "notify_clinical_lead"
  | "none";

/** `ai_lifecycle_approval_kind` — the gate a lifecycle event records. The kind names the STAGE, not the
 *  outcome: an EVALUATION→PROPOSED rejection and an EVALUATION→PILOT approval are both
 *  `stage_3_evaluation`, told apart by `from_state`/`to_state`. */
export type AiLifecycleApprovalKind =
  | "stage_1_proposal"
  | "stage_2_design_review"
  | "stage_3_evaluation"
  | "stage_4_pilot"
  | "stage_5_ga"
  | "reapproval"
  | "deprecation"
  | "retirement"
  | "incident_demotion";

// ── Vocabularies §3.2 spells inline on `text` columns (no pg type; text + CHECK) ─────────────────────

/** `ai_model_backend.zdr_status` (§3.2.4, default `not_applicable`). D19: a `cloud` backend is
 *  registrable only at `enabled` — the `cloudBaaCheck` CHECK is the DB-level guarantee. `disabled` is
 *  therefore a LOCAL-backend-only or historical value, never a live cloud route. */
export type AiZdrStatus = "enabled" | "not_applicable" | "disabled";

/** `ai_model_backend.supported_modalities` members (§3.2.4 jsonb). */
export type AiModelModality = "text" | "embedding" | "classification" | "vision";

/** `ai_model_backend.supported_features` (§3.2.4 jsonb). Snake_case on the wire because the column is
 *  a verbatim vendor-capability record, not a WardenX DTO. */
export interface AiModelBackendFeatures {
  readonly structured_output: boolean;
  readonly tool_use: boolean;
  readonly vision: boolean;
  readonly streaming: boolean;
}

/** The M2 `TenantConfiguration.ai_routing_preference` snapshotted onto
 *  `ai_tenant_opt_in_record.routing_preference_snapshot` (§3.2.6). M32 READS this; M2 owns it. */
export type AiRoutingPreference = "prefer_cloud" | "prefer_local" | "cloud_only" | "local_only";

/** The §5.3.2 routing-mode selector a Tenant Admin actually sees. NOT the same vocabulary as
 *  `AiRoutingPreference`: `default` means "inherit the capability's `default_backend_key`", which the
 *  four-value tenant preference cannot express. The two are reconciled at the routing gate (T17). */
export type AiRoutingMode = "default" | "prefer_local" | "local_only";

/** `ai_routing_override.override_reason` (§3.2.13 text). */
export type AiRoutingOverrideReason =
  | "tenant_sovereignty"
  | "tenant_cost"
  | "tenant_pilot"
  | "fallback_after_outage";

/** `ai_hallucination_report.triage_disposition` (§3.2.10 text, nullable until triaged). */
export type AiHallucinationTriageDisposition =
  | "prompt_iteration_required"
  | "model_rollback_required"
  | "edge_case_acknowledged"
  | "false_alarm";

/** `ai_prompt_template.output_entity_target_prefix` (§3.2.5) — the D13/D18 AI-prohibited-zone key.
 *  `AIPromptRegistry.getActivePromptsTargeting(prefix)` is the typed query every locked downstream
 *  module's boot validator calls; the value is an OPEN vocabulary (a new capability introduces a new
 *  target), so it is `string` on the column and this union only names the three §3.2.5 states. */
export type AiKnownOutputEntityTargetPrefix =
  | "encounter_narrative"
  | "doclens_extraction_candidate"
  | "oncall_protocol_suggestion";

/** `ai_prompt_template.output_type_prefix` (§3.2.5) — `getActivePromptsWithOutputType()`'s key. */
export type AiKnownOutputTypePrefix =
  | "narrative_text"
  | "structured_extraction"
  | "classification_label"
  | "embedding_vector";

/** `ai_invocation.consumer_context_ref` (§3.2.8 jsonb, NOT NULL) — the typed back-reference that lets a
 *  §164.528 accounting say WHICH entity's handling disclosed the PHI. `module` is the `mN` id of the
 *  consumer, never M32's own. */
export interface AiConsumerContextRef {
  readonly module: string;
  readonly entityKind: string;
  readonly entityId: string;
  readonly encounterId?: string;
  readonly extractionJobId?: string;
}

// ── §2.2 lifecycle — the consumer-facing posture each state implies ──────────────────────────────────

/**
 * §2.2's "state semantics for the consumer" table, as a value.
 *
 * Four postures, not eight, because four pairs of states are consumer-identical. The distinctions that
 * SURVIVE are the ones a caller must branch on:
 *   - `unavailable`           — the deny-stub answers; `reason` is the W9 envelope's reason.
 *   - `pilot_tenants_only`    — available only where `ai_tenant_opt_in_record.status='active' AND
 *                               pilot_enrollment=true`. A plain active opt-in is NOT enough.
 *   - `generally_available`   — available behind the ordinary tenant opt-in (APPROVED and MONITORING
 *                               are consumer-identical; MONITORING only flags an active engagement).
 *   - `existing_opt_ins_only` — DEPRECATED. Tenants already `active` keep working WITH a deprecation
 *                               notice; no tenant may newly opt in. Modelling this as `unavailable`
 *                               would cut off tenants mid-use, which is exactly what D16 does NOT want
 *                               (it demotes to DEPRECATED precisely so history and in-flight use
 *                               survive while re-activation is foreclosed).
 */
export type AiCapabilityConsumerPosture =
  | { readonly kind: "unavailable"; readonly reason: AiCapabilityUnavailableReason }
  | { readonly kind: "pilot_tenants_only" }
  | { readonly kind: "generally_available" }
  | { readonly kind: "existing_opt_ins_only" };

/**
 * The `reason` a deny-stub / a refused `aiSdk.invoke` reports (§2.2, W9, §4.2, D7).
 *
 * `phase_1_capability_shell` is this WAVE's reason and is not in the spec body: the Wave H plan ships
 * M32 as a capability shell with `ai.full` OFF, so even an `APPROVED` capability refuses. Without a
 * distinct reason a Phase-1 refusal would be indistinguishable from a capability that failed its
 * governance evaluation — the operator reading the ledger in 2027 must be able to tell "we had not
 * turned it on yet" from "it did not pass".
 */
export type AiCapabilityUnavailableReason =
  | "phase_1_capability_shell"
  | "lifecycle_state_below_approved"
  | "lifecycle_state_retired"
  | "not_enrolled_as_pilot_tenant"
  | "tenant_not_opted_in"
  | "clinician_opted_out"
  | "kill_switch_active"
  | "token_hard_cap_reached"
  // §4.2's seam unions all list `phi_minimization_failure` and §8.3 makes it the SDK's verdict when the
  // caller's `chartContext` fails the capability's strict-mode schema. T01 left it out of this union;
  // the M32-T04 invocation pipeline needs it, because the alternative — reporting a smuggled-PHI
  // rejection as the generic `backend_unhealthy` — tells the one caller who can fix it (the consumer
  // module that supplied the disallowed field) to go look at a vendor outage instead.
  | "phi_minimization_failure"
  | "backend_unhealthy"
  // M32-T06. The answer a §4.2 seam's BOOT DENY-STUB gives: no M32 implementation is registered under
  // that seam name at all. Deliberately distinct from `phase_1_capability_shell`, which the REGISTERED
  // seam gives while `ai.full` is off. In Phase 1 the two are behaviourally identical, so collapsing
  // them looks free — it stops being free the moment Phase 2 flips the flag on, when
  // `phase_1_capability_shell` becomes unreachable and this one starts meaning "the boot forgot to wire
  // M32". One reason for both would report a wiring fault as a policy decision and send the operator to
  // read the flag table instead of the boot log. M19's own `TriageAiUnavailableReason` already carries
  // this exact member for this exact case; this is the platform-wide spelling of it.
  | "provider_unregistered"
  | "output_validation_failed_after_retry";

/**
 * The §2.2/W9 envelope EVERY M32 published seam returns instead of throwing when a gate refuses.
 *
 * `currentState` is present only when the lifecycle is the reason — a caller refused for a kill switch
 * has no business learning the governance state, and W3's platform-wide kill must not leak which
 * capabilities exist. `aiSdk.invoke` (§4.1) THROWS `AICapabilityUnavailableError` carrying this same
 * shape; the seams return it, because a deny-stub that throws makes every consumer wrap it in a
 * try/catch and one of them will forget (the M20-T01 finding on synchronous deny-stub throws).
 */
export interface AiCapabilityUnavailable {
  readonly status: "capability_unavailable";
  readonly reason: AiCapabilityUnavailableReason;
  readonly currentState?: AiCapabilityLifecycleState;
}

/** A legal edge of the §2.2 FSM. `fromState: null` is the initial registration row (§2.1: "nullable for
 *  the initial PROPOSED registration"). The `packages/ai-platform` state machine holds the edge SET;
 *  this is only its shape, so a consumer can type a transition request without importing the module. */
export interface AiLifecycleTransition {
  readonly fromState: AiCapabilityLifecycleState | null;
  readonly toState: AiCapabilityLifecycleState;
  readonly approvalKind: AiLifecycleApprovalKind;
  /** Who must sign. §2.2 requires MORE THAN ONE role on the Stage-2/3/4 gates, so this is a set. */
  readonly requiredRoles: readonly AiCapabilityOwningRole[];
  /** True when `ai_capability_lifecycle_event.linked_evaluation_run_id` must be non-null (D10). */
  readonly requiresEvaluationRun: boolean;
  /** Human-readable gate name, straight from §2.2's edge labels. */
  readonly label: string;
}

// ── §2.3 / §2.4 Phase-1 registration row types (the DATA lives in `packages/ai-platform`) ────────────

/**
 * A §3.2.4 column that §2.3's inventory table does not state a value for.
 *
 * A Phase-1 seed (spec T56) has to source each of these from somewhere the spec DOES name: the signed
 * BAA + ZDR contract (`baaReference`/`zdrStatus`), the model artifact in MinIO
 * (`licenseTerms`/`artifactStorageRef`/`artifactChecksum`), the vendor's model card
 * (`modelVersionPin`/`maxOutputTokens`/`supportedFeatures`), or the deployment's service topology
 * (`healthEndpoint`). Naming them here makes the seed's dependency mechanical instead of a surprise at
 * migration time.
 */
export type AiBackendSeedFieldNotInSpec =
  | "modelVersionPin"
  | "maxOutputTokens"
  | "supportedFeatures"
  | "healthEndpoint"
  | "baaReference"
  | "zdrStatus"
  | "licenseTerms"
  | "artifactStorageRef"
  | "artifactChecksum";

/**
 * The subset of `AiBackendSeedFieldNotInSpec` a row cannot be INSERTED without, per backend kind.
 *
 * `notNull()` in §3.2.4 for both kinds: `modelVersionPin`, `maxOutputTokens`, `supportedFeatures`,
 * `healthEndpoint`. Then the two CHECK constraints add the rest conditionally — `cloudBaaCheck` forces
 * a cloud row to carry `baaReference` and `zdrStatus='enabled'` (D19's DB-level guarantee), and
 * `localLicenseCheck` forces a local row to carry `licenseTerms` and `artifactStorageRef`.
 * `artifactChecksum` is the one unstated column NEITHER constraint requires, so it is missing evidence
 * rather than a blocker.
 */
export const AI_BACKEND_SEED_BLOCKING_FIELDS: {
  readonly [K in AiModelBackendKind]: readonly AiBackendSeedFieldNotInSpec[];
} = {
  cloud: [
    "modelVersionPin",
    "maxOutputTokens",
    "supportedFeatures",
    "healthEndpoint",
    "baaReference",
    "zdrStatus",
  ],
  local: [
    "modelVersionPin",
    "maxOutputTokens",
    "supportedFeatures",
    "healthEndpoint",
    "licenseTerms",
    "artifactStorageRef",
  ],
};

/** One row of the §2.3 Phase-1 backend inventory. Fields §2.3 leaves unstated are `null`, never a
 *  plausible-looking guess: a fabricated context window silently truncates a real prompt, and a
 *  fabricated `zdr_status` would defeat the very check D19 exists to make unbypassable. */
export interface AiPhase1BackendRegistration {
  readonly backendKey: string;
  readonly kind: AiModelBackendKind;
  readonly vendor: string | null;
  readonly modelFamily: string | null;
  readonly supportedModalities: readonly AiModelModality[];
  readonly contextWindowTokens: number | null;
  /** §3.2.4 default is `true`; §2.3 registers exactly one backend inactive for lifecycle continuity. */
  readonly isActive: boolean;
  /** The capabilities §2.3 column 6 says this backend serves in Phase 1. */
  readonly servesCapabilityKeys: readonly string[];
  /** Per-row §3.2.4 NOT-NULL columns this row cannot supply, on top of
   *  `AI_BACKEND_SEED_FIELDS_NOT_IN_SPEC` (which applies to every row). */
  readonly additionalSeedBlockers: readonly (AiBackendSeedFieldNotInSpec | "contextWindowTokens")[];
  readonly note: string;
}

/** One row of the §2.4 Phase-1 capability inventory. */
export interface AiPhase1CapabilityRegistration {
  readonly capabilityKey: string;
  readonly displayName: string;
  /** `null` where no authority states it — see `AI_PHASE_1_INVENTORY_GAPS`. */
  readonly riskTier: AiCapabilityRiskTier | null;
  readonly phase1LifecycleState: AiCapabilityLifecycleState;
  /** `null` for the tabular-ML capabilities: §2.4 writes "tabular ML (XGBoost on `local-ml-worker`)",
   *  which is a SERVICE, not one of the backend keys §2.3 registers. `ai_capability.default_backend_key`
   *  is NOT NULL, so these rows are unseedable until a tabular-ML backend is registered. */
  readonly defaultBackendKey: string | null;
  /** The `mN` ids §2.4 column 6 names as Phase-1 consumers; empty where the surface is "direct UI". */
  readonly consumerModules: readonly string[];
  /** The `docs/ai/capability-catalog.yaml` id (the architecture's own catalog, which `arch:ai-governance`
   *  enforces) when this capability appears there. `null` where the architecture catalog has no entry —
   *  those capabilities are M32-spec-only and cannot be cross-checked against it. */
  readonly governanceCatalogId: string | null;
  readonly note: string;
}

/** A place where §2.4/§2.3 does not determine a NOT-NULL value, or contradicts itself or the
 *  architecture. Carried as DATA so the seed tasks (T55/T56) and reviewers see the same list. */
export interface AiPhase1InventoryGap {
  readonly id: string;
  readonly blocks: readonly string[];
  readonly detail: string;
}

// ── §3.2–§3.7 owned-table descriptors (the arguments M32-T02 passes to the M4 generators) ────────────

/** The thirteen tables `architecture/module-manifest.ts` gives M32. */
export type M32TableName =
  | "ai_capability"
  | "ai_capability_calibration"
  | "ai_capability_lifecycle_event"
  | "ai_clinician_opt_out"
  | "ai_evaluation_run"
  | "ai_hallucination_report"
  | "ai_invocation"
  | "ai_kill_switch_state"
  | "ai_model_backend"
  | "ai_prompt_template"
  | "ai_routing_override"
  | "ai_tenant_opt_in_record"
  | "ai_token_ledger";

/** The same thirteen as a runtime list (the M4 trigger loop and the §8.2 RLS proof both iterate it). */
export const M32_TABLE_NAMES = [
  "ai_capability",
  "ai_capability_calibration",
  "ai_capability_lifecycle_event",
  "ai_clinician_opt_out",
  "ai_evaluation_run",
  "ai_hallucination_report",
  "ai_invocation",
  "ai_kill_switch_state",
  "ai_model_backend",
  "ai_prompt_template",
  "ai_routing_override",
  "ai_tenant_opt_in_record",
  "ai_token_ledger",
] as const satisfies readonly M32TableName[];

/**
 * §3.3 — which RLS shape each table takes.
 *
 *   `platform_shared` — no `organization_id`. `USING (true)` SELECT to `wardenx_app`, writes only to
 *                       `wardenx_admin` (System Design §4.6). The capability registry is deliberately
 *                       world-readable within the platform: a tenant must be able to see WHICH
 *                       capabilities exist to opt in to one.
 *   `tenant_scoped`   — `organization_id` NOT NULL, policy keyed ONLY on `app.org_id`.
 *   `mixed`           — `ai_kill_switch_state` alone: `organization_id` is NULLABLE and NULL means a
 *                       PLATFORM-WIDE kill. Read spans both (`IS NULL OR = app.org_id`); INSERT is
 *                       tenant-only, so `wardenx_app` cannot mint a platform-wide kill (W3 goes through
 *                       `wardenx_admin`). This asymmetry IS the control — a single `FOR ALL` policy
 *                       would let any tenant admin kill the capability for every other tenant.
 */
export type M32TableTenancy = "platform_shared" | "tenant_scoped" | "mixed";

export const M32_TABLE_TENANCY: { readonly [K in M32TableName]: M32TableTenancy } = {
  ai_capability: "platform_shared",
  ai_capability_calibration: "platform_shared",
  ai_capability_lifecycle_event: "platform_shared",
  ai_clinician_opt_out: "tenant_scoped",
  ai_evaluation_run: "platform_shared",
  ai_hallucination_report: "tenant_scoped",
  ai_invocation: "tenant_scoped",
  ai_kill_switch_state: "mixed",
  ai_model_backend: "platform_shared",
  ai_prompt_template: "platform_shared",
  ai_routing_override: "tenant_scoped",
  ai_tenant_opt_in_record: "tenant_scoped",
  ai_token_ledger: "tenant_scoped",
};

/**
 * §3.4 — the columns the M4 write-audit trigger records as `<changed>` rather than by value.
 *
 * Two additions to the spec's five-row table, both forced by §3.2 columns §3.4 does not mention:
 *   - `ai_hallucination_report.reporter_narrative_cipher` is §3.4's entry, and §3.2.10 names the column
 *     exactly that (the §2.1 ERD's plaintext `reporter_narrative` does not exist). Kept as §3.4 spells
 *     it; the ERD is the stale side.
 *   - `ai_invocation.error_message` is denylisted by §3.4 even though it is documented "PHI-stripped".
 *     Keeping it is right: "stripped" is an assertion about a code path, and the audit ledger is not
 *     the place to find out the assertion was wrong.
 *
 * What stays OFF the list is the point. `lifecycle_state`, `risk_tier`, `status`, `routing_decision`,
 * `routing_reason`, `zdr_confirmed`, `hitl_outcome`, `severity` and `hallucination_kind` are captured
 * VERBATIM: they are exactly the fields a §164.528 accounting, an FDA inquiry or a deposition reads,
 * and a denylisted enum would make the ledger useless for the purpose it exists to serve. In
 * particular `zdr_confirmed` must be verbatim — it is the whole D19 claim.
 *
 * Every entry is UNCONDITIONAL: a trigger deciding per row whether to capture a column would have to
 * re-read the row mid-write, and the conditional would fail OPEN (the M19-T01 `answer_value_text`
 * finding).
 */
export const M32_AUDIT_DENYLIST: { readonly [K in M32TableName]: readonly string[] } = {
  ai_capability: [],
  ai_capability_calibration: [],
  ai_capability_lifecycle_event: ["stage_artifacts", "rationale_text"],
  ai_clinician_opt_out: ["reason"],
  ai_evaluation_run: [],
  ai_hallucination_report: ["reporter_narrative_cipher"],
  ai_invocation: [
    "prompt_payload_cipher",
    "response_payload_cipher",
    "chart_context_cipher",
    "error_message",
  ],
  ai_kill_switch_state: [],
  ai_model_backend: [],
  ai_prompt_template: ["clinical_reviewer_attestation"],
  ai_routing_override: [],
  ai_tenant_opt_in_record: ["disclosure_acknowledgments", "calibration_trade_off_acknowledged"],
  ai_token_ledger: [],
};

/**
 * ADR-0004 retention class each table's M4 trigger STAMPS (spec §Depends-on-M4 + §3.8).
 *
 * `platform_artifact` from the spec's dependency prose is NOT an `audit/retention.ts` class — the
 * registry has four (`operational`, `compliance`, `legal_hold`, `compliance_42cfr_part2`). The prompt
 * templates and model registry rows therefore file as `compliance`, the registry's safe default, rather
 * than inventing a fifth class in a T01 types file. Over-retaining a model-registry row costs storage;
 * under-retaining it destroys the only record of WHICH model version handled a 2026 disclosure.
 *
 * `ai_token_ledger` is `compliance` even though §3.8 gives it 6 years against `ai_invocation`'s 7: the
 * class is the trigger's stamp, and the shorter horizon is a partition-drop policy, not a second class.
 */
export const M32_AUDIT_RETENTION_CLASS: {
  readonly [K in M32TableName]: "operational" | "compliance" | "legal_hold";
} = {
  ai_capability: "compliance",
  ai_capability_calibration: "compliance",
  ai_capability_lifecycle_event: "compliance",
  ai_clinician_opt_out: "compliance",
  ai_evaluation_run: "compliance",
  ai_hallucination_report: "compliance",
  ai_invocation: "compliance",
  ai_kill_switch_state: "compliance",
  ai_model_backend: "compliance",
  ai_prompt_template: "compliance",
  ai_routing_override: "operational",
  ai_tenant_opt_in_record: "compliance",
  ai_token_ledger: "compliance",
};

/**
 * §3.5 — the immutability rule each table's trigger enforces.
 *
 *   `append_only`        — UPDATE and DELETE both refused.
 *   `no_delete`          — DELETE refused; UPDATE allowed (compliance retention without freezing).
 *   `column_restricted`  — DELETE refused and UPDATE refused on the columns in
 *                          `M32_IMMUTABLE_COLUMNS`.
 *   `mutable`            — ordinary row.
 */
export type M32ImmutabilityRule =
  | "append_only"
  | "no_delete"
  | "column_restricted"
  | "mutable";

export const M32_IMMUTABILITY_RULE: { readonly [K in M32TableName]: M32ImmutabilityRule } = {
  ai_capability: "mutable",
  // §3.5: history rows immutable; the `is_current=true` row may flip to false + set `superseded_*`.
  ai_capability_calibration: "column_restricted",
  ai_capability_lifecycle_event: "append_only",
  ai_clinician_opt_out: "mutable",
  ai_evaluation_run: "mutable",
  ai_hallucination_report: "mutable",
  ai_invocation: "column_restricted",
  ai_kill_switch_state: "mutable",
  ai_model_backend: "mutable",
  // §3.5: content fields immutable post-`approved_at`; status may only walk active→deprecated→archived.
  ai_prompt_template: "column_restricted",
  ai_routing_override: "mutable",
  ai_tenant_opt_in_record: "mutable",
  ai_token_ledger: "append_only",
};

/**
 * §3.5 — the columns a `column_restricted` table's trigger refuses to UPDATE.
 *
 * `ai_invocation`'s list is §3.5 verbatim. Note what is ABSENT: `hitl_outcome` (the one column
 * `recordHitlOutcome` writes), `status`, `completed_at`, `duration_ms`, `error_class` and
 * `error_message`. §3.5's phrase "append-only post-status='completed'" is the intent; the column list
 * is the mechanism, and the mechanism is what a trigger can enforce.
 *
 * M32-T02 correction — an earlier draft of this comment also named `response_payload_cipher` as absent,
 * on the reading that the row is INSERTed before the backend answers. The ARRAY (which is §3.5 verbatim,
 * and which the 0116 trigger now enforces column-for-column) freezes it, and the array is right: the
 * response side is written ONCE, at insert, from the completed call — including a call that failed,
 * timed out or was refused, each of which is a terminal status known before the row exists. Only
 * `hitl_outcome` and the operational status columns change afterwards. The two readings differ in what
 * a partially-written invocation row can look like, and the frozen one has no such state.
 *
 * ONE EXCEPTION the trigger admits and this list cannot express: §3.7's destruction path may replace a
 * cipher with the SHRED SENTINEL (the empty bytea for the NOT NULL `prompt_payload_cipher`, NULL for the
 * two optional ones). A cipher may be DESTROYED, never replaced — which is what lets the eraser run with
 * no privileged bypass and no new session variable.
 */
export const M32_IMMUTABLE_COLUMNS: {
  readonly [K in M32TableName]: readonly string[];
} = {
  ai_capability: [],
  ai_capability_calibration: [
    "capability_id",
    "backend_key",
    "thresholds",
    "baseline_metrics",
    "baseline_set_at",
    "baseline_evaluation_run_id",
  ],
  ai_capability_lifecycle_event: [],
  ai_clinician_opt_out: [],
  ai_evaluation_run: [],
  ai_hallucination_report: [],
  ai_invocation: [
    "id",
    "organization_id",
    "capability_id",
    "prompt_payload_cipher",
    "response_payload_cipher",
    "chart_context_cipher",
    "input_token_count",
    "output_token_count",
    "model_version_pin",
    "prompt_template_version",
    "zdr_confirmed",
    "invoked_at",
  ],
  ai_kill_switch_state: [],
  ai_model_backend: [],
  ai_prompt_template: [
    "template_key",
    "capability_key",
    "version",
    "template_filesystem_ref",
    "template_content_hash",
    "compatible_backend_keys",
    "input_schema_ref",
    "output_schema_ref",
    "output_entity_target_prefix",
    "output_type_prefix",
  ],
  ai_routing_override: [],
  ai_tenant_opt_in_record: [],
  ai_token_ledger: [],
};

/** §3.6 — the columns registered with M1's per-tenant DEK envelope-encryption helper. Encryption
 *  happens in the M32 SDK BEFORE insert and decryption at the M32 service route, never at the database
 *  layer, so a DB-side reader (a replica, a backup, an `ai_invocation` partition on cold storage) never
 *  holds plaintext PHI. */
export const M32_CIPHER_COLUMNS: { readonly [K in M32TableName]: readonly string[] } = {
  ai_capability: [],
  ai_capability_calibration: [],
  ai_capability_lifecycle_event: [],
  ai_clinician_opt_out: [],
  ai_evaluation_run: [],
  ai_hallucination_report: ["reporter_narrative_cipher"],
  ai_invocation: ["prompt_payload_cipher", "response_payload_cipher", "chart_context_cipher"],
  ai_kill_switch_state: [],
  ai_model_backend: [],
  ai_prompt_template: [],
  ai_routing_override: [],
  ai_tenant_opt_in_record: [],
  ai_token_ledger: [],
};

/** The two tables partitioned monthly (§3.8). Their PK is composite BECAUSE of this — the partition key
 *  must be in every UNIQUE index (ADR-0022 D1.1, which `arch:ddl` enforces). */
export const M32_PARTITIONED_TABLES: {
  readonly [K in "ai_invocation" | "ai_token_ledger"]: { readonly partitionKey: string; readonly retentionYears: number };
} = {
  ai_invocation: { partitionKey: "invoked_at", retentionYears: 7 },
  ai_token_ledger: { partitionKey: "accrued_at", retentionYears: 6 },
};

/**
 * §3.7 — the two M4 `DataEraser` data classes M32 registers at boot (M32-T21/T23 do the registering and
 * widen `DataClass`; T01 only NAMES them, so adding the union member without a registered eraser cannot
 * fail `validateErasers()` mid-wave).
 *
 * NEITHER erase is a delete. Both are a cryptographic shred of the per-tenant DEK: the `ai_invocation`
 * rows survive with their token counts, model pin, ZDR flag and timestamps intact, because those rows
 * ARE the §164.528 accounting-of-disclosures evidence — destroying them would destroy the record that
 * the disclosure happened, which is the opposite of what a destruction certificate is for. Two classes
 * rather than one because M22's intake provenance and M8's clinical-record provenance map to distinct
 * M4 data classes (§3.7), and the registry is single-keyed.
 */
export const M32_ERASER_DATA_CLASSES = {
  /** HearthNote Layer 2 / IDG polish / copilot / prediction invocations against a patient's chart. */
  clinicalRecord: "clinical_record_ai_provenance",
  /** DocLens invocations against a patient's intake documents. */
  intake: "intake_ai_provenance",
} as const;

// ── Phase-1 flag posture ─────────────────────────────────────────────────────────────────────────────

/**
 * The Part-A capability flag that unlocks real AI execution. OFF for every tenant in Phase 1 (Wave H
 * plan: "M32 — capability shell only"), which is the OUTERMOST gate: a capability sitting at `APPROVED`
 * in the registry still answers `capability_unavailable` with reason `phase_1_capability_shell`.
 *
 * The literal is `"ai.full"`, matching the flag M16 (`BEREAVEMENT_AI_FULL_FLAG`) and M38 already read —
 * one flag, three readers, no second spelling.
 */
export const AI_FULL_FLAG = "ai.full" as const;

/** The Phase-1 refusal every published M32 seam returns while `ai.full` is off. A frozen VALUE rather
 *  than a per-seam literal so a consumer can compare against it, and so flipping Phase 2 on is a change
 *  at one site. */
export const AI_PHASE_1_SHELL_REFUSAL: AiCapabilityUnavailable = {
  status: "capability_unavailable",
  reason: "phase_1_capability_shell",
};

// ── Actor identity M32 asserts on outbound system-actor calls ────────────────────────────────────────

/** The `actor_kind` discriminator M32 sets when IT calls another module's read seam as a system actor —
 *  the value M12 D12 / M13 D15 / M18 D13 / M21 D15 already refuse at their mutating routes (D18's
 *  runtime leg). M32 never sets it on a user-facing M32 route: those carry the real M2 actor. */
export const AI_PLATFORM_INVOKER_ACTOR_KIND = "ai_platform_invoker" as const;

/** The invocation context an `aiSdk.invoke` call carries (§4.1). `organizationId` is set from the
 *  actor's SESSION, never from a request body (§2.6's cross-tenant isolation invariant (a)); it is
 *  present here so the SDK signature is typed, not so a caller can choose it. */
export interface AiInvocationContext {
  readonly organizationId: OrgId;
  readonly actorMembershipId: MembershipId;
  readonly actorRole: string;
  /** Present only when the invocation touches a patient's chart — the §3.2.8 PHI presence indicator. */
  readonly patientId?: PatientId;
  readonly consumerCorrelationId?: AiConsumerCorrelationId;
  readonly consumerContextRef: AiConsumerContextRef;
  readonly invokedAt: IsoInstant;
}
