// Module 32 (AI Platform) — M32-T01 contract drift guards.
//
// `packages/types/src/ai-platform.ts` says its enum mirrors are "kept in lock-step with
// `packages/db/src/enums.ts`". A comment does not keep anything in lock-step. These tests are where the
// claim is enforced: `@wardenx/types` is a LEAF and cannot import `@wardenx/db`, so the two sides can
// only be compared somewhere that already depends on both — the backend, which is exactly the consumer
// that would ship the drift.
//
// Several assertions below pin a deliberate DEVIATION from the spec body (the five §3.1 enum members the
// §2.1 ERD omits, the seventeen-not-eighteen capability count, the `compliance` stamp where the spec's
// prose says `platform_artifact`). Each is the kind of decision that quietly reverts the next time
// someone reads §2 verbatim, so it is asserted rather than commented.

import { describe, expect, it } from "vitest";

import { AI_PHASE_1_BACKENDS, AI_PHASE_1_CAPABILITIES } from "@wardenx/ai-platform";
import {
  aiBackendHealthStatus,
  aiCapabilityLifecycleState,
  aiCapabilityOwningRole,
  aiCapabilityRiskTier,
  aiEvaluationRunDecision,
  aiEvaluationRunStage,
  aiEvaluationRunStatus,
  aiFdaSamdClassification,
  aiHallucinationKind,
  aiHallucinationSeverity,
  aiHallucinationTriageStatus,
  aiInvocationHitlOutcome,
  aiInvocationStatus,
  aiKillSwitchActivationActorKind,
  aiKillSwitchReason,
  aiLifecycleApprovalKind,
  aiModelBackendKind,
  aiPromptTemplateStatus,
  aiRoutingDecision,
  aiRoutingReason,
  aiTenantOptInStatus,
} from "@wardenx/db/schema";
import {
  AI_BACKEND_SEED_BLOCKING_FIELDS,
  AI_CAPABILITY_LIFECYCLE_STATES,
  AI_FULL_FLAG,
  AI_HALLUCINATION_OPEN_TRIAGE_STATUSES,
  AI_KILL_SWITCH_AUTOMATED_ACTOR_KINDS,
  AI_PHASE_1_SHELL_REFUSAL,
  AI_PLATFORM_INVOKER_ACTOR_KIND,
  type AiBackendHealthStatus,
  type AiCapabilityLifecycleState,
  type AiCapabilityOwningRole,
  type AiCapabilityRiskTier,
  type AiEvaluationRunDecision,
  type AiEvaluationRunStage,
  type AiEvaluationRunStatus,
  type AiFdaSamdClassification,
  type AiHallucinationKind,
  type AiHallucinationSeverity,
  type AiHallucinationTriageStatus,
  type AiInvocationHitlOutcome,
  type AiInvocationStatus,
  type AiKillSwitchActorKind,
  type AiKillSwitchReason,
  type AiLifecycleApprovalKind,
  type AiModelBackendKind,
  type AiPromptTemplateStatus,
  type AiRoutingDecision,
  type AiRoutingReason,
  type AiTenantOptInStatus,
  M32_AUDIT_DENYLIST,
  M32_AUDIT_RETENTION_CLASS,
  M32_CIPHER_COLUMNS,
  M32_ERASER_DATA_CLASSES,
  M32_IMMUTABILITY_RULE,
  M32_IMMUTABLE_COLUMNS,
  M32_PARTITIONED_TABLES,
  M32_TABLE_NAMES,
  M32_TABLE_TENANCY,
} from "@wardenx/types";
import { MODULES } from "../../../architecture/module-manifest";

/** Each triple is (SQL type name, the pgEnum's runtime values, the leaf union's members). The third
 *  element is a `satisfies`-checked literal array, so a member added to the TS union without being added
 *  here is a COMPILE error and a member added to the pgEnum without the union is a RUNTIME failure.
 *  Neither side can drift alone. */
const MIRRORS = [
  [
    "ai_capability_lifecycle_state",
    aiCapabilityLifecycleState.enumValues,
    [
      "PROPOSED",
      "DESIGN_REVIEW",
      "EVALUATION",
      "PILOT",
      "APPROVED",
      "MONITORING",
      "DEPRECATED",
      "RETIRED",
    ] satisfies AiCapabilityLifecycleState[],
  ],
  [
    "ai_capability_risk_tier",
    aiCapabilityRiskTier.enumValues,
    ["high", "medium", "low"] satisfies AiCapabilityRiskTier[],
  ],
  [
    "ai_capability_owning_role",
    aiCapabilityOwningRole.enumValues,
    [
      "ai_safety_owner",
      "clinical_reviewer",
      "ai_engineer",
      "privacy_officer",
    ] satisfies AiCapabilityOwningRole[],
  ],
  [
    "ai_fda_samd_classification",
    aiFdaSamdClassification.enumValues,
    [
      "class_i",
      "class_ii",
      "class_iii",
      "class_iv",
      "not_samd",
    ] satisfies AiFdaSamdClassification[],
  ],
  [
    "ai_model_backend_kind",
    aiModelBackendKind.enumValues,
    ["cloud", "local"] satisfies AiModelBackendKind[],
  ],
  [
    "ai_backend_health_status",
    aiBackendHealthStatus.enumValues,
    ["healthy", "degraded", "unhealthy", "unknown"] satisfies AiBackendHealthStatus[],
  ],
  [
    "ai_prompt_template_status",
    aiPromptTemplateStatus.enumValues,
    ["active", "deprecated", "archived"] satisfies AiPromptTemplateStatus[],
  ],
  [
    "ai_tenant_opt_in_status",
    aiTenantOptInStatus.enumValues,
    ["active", "paused", "opted_out"] satisfies AiTenantOptInStatus[],
  ],
  [
    "ai_invocation_status",
    aiInvocationStatus.enumValues,
    [
      "completed",
      "failed",
      "timed_out",
      "killed",
      "capability_unavailable",
    ] satisfies AiInvocationStatus[],
  ],
  [
    "ai_invocation_hitl_outcome",
    aiInvocationHitlOutcome.enumValues,
    [
      "accepted",
      "edited",
      "rejected",
      "pending",
      "not_applicable",
    ] satisfies AiInvocationHitlOutcome[],
  ],
  [
    "ai_routing_decision",
    aiRoutingDecision.enumValues,
    ["primary", "fallback_1", "fallback_2"] satisfies AiRoutingDecision[],
  ],
  [
    "ai_routing_reason",
    aiRoutingReason.enumValues,
    [
      "default",
      "tenant_override",
      "kill_switch_fallback",
      "vendor_outage_fallback",
      "cost_cap_fallback",
    ] satisfies AiRoutingReason[],
  ],
  [
    "ai_hallucination_severity",
    aiHallucinationSeverity.enumValues,
    ["critical", "high", "medium", "low"] satisfies AiHallucinationSeverity[],
  ],
  [
    "ai_hallucination_kind",
    aiHallucinationKind.enumValues,
    [
      "fabricated_medication",
      "misattributed_symptom",
      "fake_diagnosis",
      "fabricated_quote",
      "misquoted_patient",
      "wrong_dose",
      "fake_clinical_recommendation",
      "other",
    ] satisfies AiHallucinationKind[],
  ],
  [
    "ai_hallucination_triage_status",
    aiHallucinationTriageStatus.enumValues,
    [
      "open",
      "investigating",
      "root_cause_identified",
      "mitigated",
      "closed",
      "escalated_to_clinical_safety",
    ] satisfies AiHallucinationTriageStatus[],
  ],
  [
    "ai_evaluation_run_stage",
    aiEvaluationRunStage.enumValues,
    [
      "stage_3_evaluation",
      "stage_4_pilot",
      "reapproval",
      "drift_response",
      "post_incident",
    ] satisfies AiEvaluationRunStage[],
  ],
  [
    "ai_evaluation_run_status",
    aiEvaluationRunStatus.enumValues,
    ["pending", "in_progress", "passed", "failed", "aborted"] satisfies AiEvaluationRunStatus[],
  ],
  [
    "ai_evaluation_run_decision",
    aiEvaluationRunDecision.enumValues,
    [
      "approve_for_pilot",
      "approve_for_ga",
      "reject",
      "recalibrate_thresholds",
      "no_decision",
    ] satisfies AiEvaluationRunDecision[],
  ],
  [
    "ai_kill_switch_reason",
    aiKillSwitchReason.enumValues,
    [
      "sev1_hallucination",
      "sev2_hallucination",
      "cost_cap_reached",
      "vendor_outage_exceeded_sla",
      "prompt_injection_detected",
      "manual_safety_pause",
      "misuse_detected",
      "bias_drift_severe",
      "lifecycle_demotion",
    ] satisfies AiKillSwitchReason[],
  ],
  [
    "ai_kill_switch_activation_actor_kind",
    aiKillSwitchActivationActorKind.enumValues,
    [
      "ai_safety_owner",
      "incident_commander",
      "automated_cost_watch",
      "automated_drift_monitor",
      "automated_vendor_health_monitor",
      "automated_lifecycle_demotion",
    ] satisfies AiKillSwitchActorKind[],
  ],
  [
    "ai_lifecycle_approval_kind",
    aiLifecycleApprovalKind.enumValues,
    [
      "stage_1_proposal",
      "stage_2_design_review",
      "stage_3_evaluation",
      "stage_4_pilot",
      "stage_5_ga",
      "reapproval",
      "deprecation",
      "retirement",
      "incident_demotion",
    ] satisfies AiLifecycleApprovalKind[],
  ],
] as const satisfies readonly (readonly [string, readonly string[], readonly string[]])[];

describe("§3.1 pgEnum ↔ @wardenx/types mirror", () => {
  it.each(MIRRORS)("%s carries the same members on both sides", (_name, pgValues, unionValues) => {
    expect([...pgValues].sort()).toEqual([...unionValues].sort());
  });

  it("declares all twenty-one §3.1 enums", () => {
    expect(MIRRORS).toHaveLength(21);
  });

  it("keeps the five §3.1 members the §2.1 ERD omits — each one is load-bearing", () => {
    // Without these the ledger cannot distinguish a hard-cap fallback from an outage, an automated
    // demotion from a human pause, a pending run from a rejected one, or an unprobed backend from an
    // unhealthy one.
    expect(aiRoutingReason.enumValues).toContain("cost_cap_fallback");
    expect(aiKillSwitchReason.enumValues).toContain("lifecycle_demotion");
    expect(aiEvaluationRunDecision.enumValues).toContain("no_decision");
    expect(aiBackendHealthStatus.enumValues).toContain("unknown");
    expect(aiHallucinationKind.enumValues).toContain("fake_clinical_recommendation");
  });

  it("orders the lifecycle tuple as the promotion ladder", () => {
    expect(AI_CAPABILITY_LIFECYCLE_STATES).toEqual(aiCapabilityLifecycleState.enumValues);
    expect(AI_CAPABILITY_LIFECYCLE_STATES[0]).toBe("PROPOSED");
    expect(AI_CAPABILITY_LIFECYCLE_STATES.at(-1)).toBe("RETIRED");
  });

  it("names only automated kinds in the membership-less activation set (§3.2.12)", () => {
    for (const kind of AI_KILL_SWITCH_AUTOMATED_ACTOR_KINDS) {
      expect(kind.startsWith("automated_")).toBe(true);
      expect(aiKillSwitchActivationActorKind.enumValues).toContain(kind);
    }
    expect(AI_KILL_SWITCH_AUTOMATED_ACTOR_KINDS as readonly string[]).not.toContain(
      "ai_safety_owner",
    );
  });

  it("covers the §3.2.10 open-triage partial index with real statuses", () => {
    for (const status of AI_HALLUCINATION_OPEN_TRIAGE_STATUSES) {
      expect(aiHallucinationTriageStatus.enumValues).toContain(status);
    }
    // `escalated_to_clinical_safety` is terminal for M32's queue and must not re-enter the working set.
    expect(AI_HALLUCINATION_OPEN_TRIAGE_STATUSES as readonly string[]).not.toContain(
      "escalated_to_clinical_safety",
    );
  });
});

describe("§3.2 owned tables ↔ the manifest", () => {
  const m32 = MODULES.find((m) => m.id === 32);

  it("mirrors the manifest's ownedTables exactly — the manifest is the source of truth", () => {
    expect(m32).toBeDefined();
    expect([...M32_TABLE_NAMES].sort()).toEqual([...(m32?.ownedTables ?? [])].sort());
  });

  it("owns thirteen tables", () => {
    expect(M32_TABLE_NAMES).toHaveLength(13);
  });

  it("declares a tenancy, denylist, retention class, immutability rule and cipher set per table", () => {
    for (const table of M32_TABLE_NAMES) {
      expect(M32_TABLE_TENANCY[table]).toBeDefined();
      expect(M32_AUDIT_DENYLIST[table]).toBeDefined();
      expect(M32_AUDIT_RETENTION_CLASS[table]).toBeDefined();
      expect(M32_IMMUTABILITY_RULE[table]).toBeDefined();
      expect(M32_CIPHER_COLUMNS[table]).toBeDefined();
      expect(M32_IMMUTABLE_COLUMNS[table]).toBeDefined();
    }
  });

  it("splits §3.3's three RLS shapes exactly as the spec does", () => {
    const byShape = (shape: string) =>
      M32_TABLE_NAMES.filter((t) => M32_TABLE_TENANCY[t] === shape).sort();
    expect(byShape("platform_shared")).toEqual([
      "ai_capability",
      "ai_capability_calibration",
      "ai_capability_lifecycle_event",
      "ai_evaluation_run",
      "ai_model_backend",
      "ai_prompt_template",
    ]);
    expect(byShape("tenant_scoped")).toEqual([
      "ai_clinician_opt_out",
      "ai_hallucination_report",
      "ai_invocation",
      "ai_routing_override",
      "ai_tenant_opt_in_record",
      "ai_token_ledger",
    ]);
    // Exactly one mixed table: organization_id NULL means a PLATFORM-WIDE kill (D8/W3).
    expect(byShape("mixed")).toEqual(["ai_kill_switch_state"]);
  });

  it("denylists every §3.4 column and nothing surveyor-facing", () => {
    expect([...M32_AUDIT_DENYLIST.ai_invocation].sort()).toEqual([
      "chart_context_cipher",
      "error_message",
      "prompt_payload_cipher",
      "response_payload_cipher",
    ]);
    expect(M32_AUDIT_DENYLIST.ai_hallucination_report).toEqual(["reporter_narrative_cipher"]);
    expect([...M32_AUDIT_DENYLIST.ai_tenant_opt_in_record].sort()).toEqual([
      "calibration_trade_off_acknowledged",
      "disclosure_acknowledgments",
    ]);
    expect([...M32_AUDIT_DENYLIST.ai_capability_lifecycle_event].sort()).toEqual([
      "rationale_text",
      "stage_artifacts",
    ]);
    expect(M32_AUDIT_DENYLIST.ai_prompt_template).toEqual(["clinical_reviewer_attestation"]);

    // `zdr_confirmed` IS the D19 claim; a denylisted ZDR flag would make the §164.528 accounting
    // unable to answer the only question it exists to answer.
    for (const column of [
      "zdr_confirmed",
      "status",
      "routing_decision",
      "routing_reason",
      "hitl_outcome",
      "backend_key",
      "model_version_pin",
      "capability_key",
    ]) {
      expect(M32_AUDIT_DENYLIST.ai_invocation).not.toContain(column);
    }
    for (const column of ["severity", "hallucination_kind", "triage_status"]) {
      expect(M32_AUDIT_DENYLIST.ai_hallucination_report).not.toContain(column);
    }
  });

  it("uses real `audit_retention_class` members, not the spec's `platform_artifact` prose label", () => {
    for (const table of M32_TABLE_NAMES) {
      expect(["operational", "compliance", "legal_hold"]).toContain(
        M32_AUDIT_RETENTION_CLASS[table],
      );
    }
    // The two §164.528 evidence tables are compliance, and so is the model/prompt registry the
    // spec's prose calls `platform_artifact` — the registry has no such class.
    expect(M32_AUDIT_RETENTION_CLASS.ai_invocation).toBe("compliance");
    expect(M32_AUDIT_RETENTION_CLASS.ai_hallucination_report).toBe("compliance");
    expect(M32_AUDIT_RETENTION_CLASS.ai_prompt_template).toBe("compliance");
    expect(M32_AUDIT_RETENTION_CLASS.ai_model_backend).toBe("compliance");
  });

  it("keeps the response side of `ai_invocation` writable exactly once (§3.5)", () => {
    // The row is INSERTed before the backend answers. Freezing these would make the completion
    // UPDATE illegal and the pipeline would have to skip the audit row — the one thing §2.6 forbids.
    for (const column of [
      "hitl_outcome",
      "status",
      "completed_at",
      "duration_ms",
      "error_class",
      "error_message",
    ]) {
      expect(M32_IMMUTABLE_COLUMNS.ai_invocation).not.toContain(column);
    }
    expect(M32_IMMUTABLE_COLUMNS.ai_invocation).toContain("zdr_confirmed");
    expect(M32_IMMUTABLE_COLUMNS.ai_invocation).toContain("invoked_at");
    expect(M32_IMMUTABILITY_RULE.ai_invocation).toBe("column_restricted");
  });

  it("makes the two ledgers append-only and everything else at least delete-safe", () => {
    expect(M32_IMMUTABILITY_RULE.ai_capability_lifecycle_event).toBe("append_only");
    expect(M32_IMMUTABILITY_RULE.ai_token_ledger).toBe("append_only");
    // Only a `column_restricted` table declares frozen columns; the others must declare none, or the
    // list would be an instruction nothing reads.
    for (const table of M32_TABLE_NAMES) {
      if (M32_IMMUTABILITY_RULE[table] !== "column_restricted") {
        expect(M32_IMMUTABLE_COLUMNS[table]).toEqual([]);
      } else {
        expect(M32_IMMUTABLE_COLUMNS[table].length).toBeGreaterThan(0);
      }
    }
  });

  it("registers every cipher column on the denylist too (§3.4/§3.6)", () => {
    for (const table of M32_TABLE_NAMES) {
      for (const column of M32_CIPHER_COLUMNS[table]) {
        expect(M32_AUDIT_DENYLIST[table]).toContain(column);
      }
    }
    expect(M32_CIPHER_COLUMNS.ai_invocation).toHaveLength(3);
    expect(M32_CIPHER_COLUMNS.ai_hallucination_report).toHaveLength(1);
  });

  it("partitions exactly the two §3.8 tables, each by its own time column", () => {
    expect(Object.keys(M32_PARTITIONED_TABLES).sort()).toEqual([
      "ai_invocation",
      "ai_token_ledger",
    ]);
    expect(M32_PARTITIONED_TABLES.ai_invocation.partitionKey).toBe("invoked_at");
    expect(M32_PARTITIONED_TABLES.ai_token_ledger.partitionKey).toBe("accrued_at");
    // §3.8: 7 years for the disclosure record, 6 for the SaaS billing trail.
    expect(M32_PARTITIONED_TABLES.ai_invocation.retentionYears).toBe(7);
    expect(M32_PARTITIONED_TABLES.ai_token_ledger.retentionYears).toBe(6);
  });

  it("names two distinct eraser data classes, neither colliding with another module's", () => {
    expect(M32_ERASER_DATA_CLASSES.clinicalRecord).toBe("clinical_record_ai_provenance");
    expect(M32_ERASER_DATA_CLASSES.intake).toBe("intake_ai_provenance");
    // Distinct from M8's `encounter_record` and M5's `clinical_record` — the registry is single-keyed.
    expect(M32_ERASER_DATA_CLASSES.clinicalRecord).not.toBe("clinical_record");
  });
});

describe("Phase-1 shell posture (Wave H plan)", () => {
  it("reads the same `ai.full` flag M16 and M38 already read", () => {
    expect(AI_FULL_FLAG).toBe("ai.full");
  });

  it("refuses with a reason distinguishable from a failed governance evaluation", () => {
    expect(AI_PHASE_1_SHELL_REFUSAL).toEqual({
      status: "capability_unavailable",
      reason: "phase_1_capability_shell",
    });
    expect(AI_PHASE_1_SHELL_REFUSAL.currentState).toBeUndefined();
  });

  it("keeps the D18 invoker discriminator on the value the prohibited modules already refuse", () => {
    expect(AI_PLATFORM_INVOKER_ACTOR_KIND).toBe("ai_platform_invoker");
  });
});

describe("§2.3/§2.4 inventory ↔ the enum surface", () => {
  it("registers only backends whose kind is a real `ai_model_backend_kind`", () => {
    for (const backend of AI_PHASE_1_BACKENDS) {
      expect(aiModelBackendKind.enumValues).toContain(backend.kind);
      expect(AI_BACKEND_SEED_BLOCKING_FIELDS[backend.kind].length).toBeGreaterThan(0);
    }
  });

  it("registers only capabilities whose lifecycle state and risk tier are real enum members", () => {
    for (const capability of AI_PHASE_1_CAPABILITIES) {
      expect(aiCapabilityLifecycleState.enumValues).toContain(capability.phase1LifecycleState);
      if (capability.riskTier !== null) {
        expect(aiCapabilityRiskTier.enumValues).toContain(capability.riskTier);
      }
    }
  });
});
