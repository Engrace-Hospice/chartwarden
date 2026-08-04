// Module 32 — §2.2 / §3.2.3 / §5.3 / §5.4 governance rules (M32-T03).
//
// These are the gates that decide whether a clinical AI capability may be promoted, whether an agency's
// PHI may be sent to a model, and whether an individual clinician's refusal is honoured. Each test
// below pins a rule that would otherwise be a comment — and, where the rule has a plausible opposite
// (the fast track, the conditional BAA gate, the DEPRECATED re-opt-in), the opposite is asserted too.

import { describe, expect, it } from "vitest";

import {
  AI_REAPPROVAL_INTERVAL_MONTHS,
  aiCloudReachableUnder,
  aiGovernanceGateFor,
  aiLifecycleTransition,
  aiNextReapprovalDueAt,
  aiRequiredSignerRoles,
  aiResolveRoutingPreference,
  aiTenantOptInOfferable,
  evaluateAiCalibrationPublication,
  evaluateAiClinicianOptOut,
  evaluateAiClinicianOptOutRevert,
  evaluateAiLifecycleTransition,
  evaluateAiTenantOptIn,
  evaluateAiTenantOptInPause,
  evaluateAiTenantOptInWithdrawal,
} from "../src/index";
import type {
  AiLifecycleCapabilitySnapshot,
  AiOptInCapabilitySnapshot,
  AiOptInResolvedEvidence,
  AiTenantOptInRequest,
} from "../src/index";

const T0 = "2026-01-15T12:00:00.000Z";

// ── §2.2 lifecycle gate ────────────────────────────────────────────────────────────────────────────

const approvedReady: AiLifecycleCapabilitySnapshot = {
  lifecycleState: "PILOT",
  riskTier: "high",
  currentPromptTemplateKey: "hearthnote_enhancement_v1",
  firstApprovedAt: null,
};

describe("§2.2 lifecycle gate", () => {
  it("promotes PILOT → APPROVED for a signer §2.2 names, with the run D10 demands", () => {
    const decision = evaluateAiLifecycleTransition(
      approvedReady,
      {
        toState: "APPROVED",
        approvalKind: "stage_4_pilot",
        actorRole: "clinical_reviewer",
        rationaleText: "pilot metrics met every threshold",
        linkedEvaluationRunId: "run-1",
      },
      T0,
    );
    expect(decision.ok).toBe(true);
    if (decision.ok !== true) return;
    expect(decision.patch.lifecycleState).toBe("APPROVED");
    // First approval stamps the anchor AND starts the annual clock (decision 2 in the file header) —
    // a serving capability with a null due date never appears in the reapproval sweep's partial index.
    expect(decision.patch.firstApprovedAt).toBe(T0);
    expect(decision.patch.nextReapprovalDueAt).toBe("2027-01-15T12:00:00.000Z");
  });

  it("refuses an edge §2.2 does not draw", () => {
    const decision = evaluateAiLifecycleTransition(
      { ...approvedReady, lifecycleState: "PROPOSED" },
      {
        toState: "APPROVED",
        approvalKind: "stage_4_pilot",
        actorRole: "ai_safety_owner",
        rationaleText: "skip the ladder",
        linkedEvaluationRunId: "run-1",
      },
      T0,
    );
    expect(decision).toMatchObject({ ok: false, code: "AI_LIFECYCLE_INVALID_TRANSITION" });
  });

  it("refuses a signer whose role the gate does not name", () => {
    const decision = evaluateAiLifecycleTransition(
      { ...approvedReady, lifecycleState: "DESIGN_REVIEW" },
      {
        toState: "EVALUATION",
        approvalKind: "stage_2_design_review",
        actorRole: "ai_engineer",
        rationaleText: "design looks fine to me",
        linkedEvaluationRunId: null,
      },
      T0,
    );
    expect(decision).toMatchObject({ ok: false, code: "AI_LIFECYCLE_SIGNER_ROLE_INSUFFICIENT" });
  });

  it("refuses a promotion with no evaluation run where D10 requires one", () => {
    const decision = evaluateAiLifecycleTransition(
      approvedReady,
      {
        toState: "APPROVED",
        approvalKind: "stage_4_pilot",
        actorRole: "ai_safety_owner",
        rationaleText: "it seems fine",
        linkedEvaluationRunId: null,
      },
      T0,
    );
    expect(decision).toMatchObject({ ok: false, code: "AI_LIFECYCLE_EVALUATION_RUN_REQUIRED" });
  });

  it("refuses APPROVED without a prompt template, rather than letting the CHECK 500", () => {
    const decision = evaluateAiLifecycleTransition(
      { ...approvedReady, currentPromptTemplateKey: null },
      {
        toState: "APPROVED",
        approvalKind: "stage_4_pilot",
        actorRole: "ai_safety_owner",
        rationaleText: "ready",
        linkedEvaluationRunId: "run-1",
      },
      T0,
    );
    expect(decision).toMatchObject({ ok: false, code: "AI_LIFECYCLE_PROMPT_TEMPLATE_REQUIRED" });
  });

  it("refuses a blank rationale — the ledger row exists to say why", () => {
    const decision = evaluateAiLifecycleTransition(
      approvedReady,
      {
        toState: "APPROVED",
        approvalKind: "stage_4_pilot",
        actorRole: "ai_safety_owner",
        rationaleText: "   ",
        linkedEvaluationRunId: "run-1",
      },
      T0,
    );
    expect(decision).toMatchObject({ ok: false, code: "AI_LIFECYCLE_RATIONALE_REQUIRED" });
  });

  it("clears the re-approval due date on the way out of the serving states", () => {
    const decision = evaluateAiLifecycleTransition(
      {
        lifecycleState: "APPROVED",
        riskTier: "high",
        currentPromptTemplateKey: "tpl",
        firstApprovedAt: T0,
      },
      {
        toState: "DEPRECATED",
        approvalKind: "incident_demotion",
        actorRole: "ai_safety_owner",
        rationaleText: "SEV-1 hallucination",
        linkedEvaluationRunId: null,
      },
      "2026-06-01T00:00:00.000Z",
    );
    expect(decision.ok).toBe(true);
    if (decision.ok !== true) return;
    expect(decision.patch.nextReapprovalDueAt).toBeNull();
    // A demotion is NOT a first approval and NOT a re-approval — neither anchor moves.
    expect(decision.patch.firstApprovedAt).toBeUndefined();
    expect(decision.patch.lastReapprovedAt).toBeUndefined();
  });

  it("rolls the clock forward on a re-approval without moving the state", () => {
    const decision = evaluateAiLifecycleTransition(
      {
        lifecycleState: "MONITORING",
        riskTier: "medium",
        currentPromptTemplateKey: "tpl",
        firstApprovedAt: T0,
      },
      {
        toState: "MONITORING",
        approvalKind: "reapproval",
        actorRole: "ai_safety_owner",
        rationaleText: "biennial review complete",
        linkedEvaluationRunId: "run-9",
      },
      "2028-01-15T12:00:00.000Z",
    );
    expect(decision.ok).toBe(true);
    if (decision.ok !== true) return;
    expect(decision.patch.lastReapprovedAt).toBe("2028-01-15T12:00:00.000Z");
    expect(decision.patch.nextReapprovalDueAt).toBe("2030-01-15T12:00:00.000Z");
  });
});

describe("AI Governance §5.6/§5.7 — cadence and the Low-risk fast track", () => {
  it("drops the Clinical Reviewer for a Low-risk capability and for nothing else", () => {
    const stage4 = aiLifecycleTransition("PILOT", "APPROVED", "stage_4_pilot");
    expect(stage4).not.toBeNull();
    if (!stage4) return;
    expect(aiRequiredSignerRoles(stage4, "high")).toContain("clinical_reviewer");
    expect(aiRequiredSignerRoles(stage4, "medium")).toContain("clinical_reviewer");
    const low = aiRequiredSignerRoles(stage4, "low");
    expect(low).not.toContain("clinical_reviewer");
    // §5.7 removes the reviewer, never the AI Safety Owner.
    expect(low).toContain("ai_safety_owner");
  });

  it("leaves Low risk with NO due date rather than a fabricated cadence", () => {
    expect(AI_REAPPROVAL_INTERVAL_MONTHS.low).toBeNull();
    expect(aiNextReapprovalDueAt("APPROVED", "low", T0)).toBeNull();
    expect(aiNextReapprovalDueAt("APPROVED", "high", T0)).toBe("2027-01-15T12:00:00.000Z");
    expect(aiNextReapprovalDueAt("APPROVED", "medium", T0)).toBe("2028-01-15T12:00:00.000Z");
    // Non-serving states carry none regardless of tier.
    expect(aiNextReapprovalDueAt("PILOT", "high", T0)).toBeNull();
  });
});

// ── §3.2.3 calibration ─────────────────────────────────────────────────────────────────────────────

describe("§3.2.3 calibration publication", () => {
  const capability = {
    defaultBackendKey: "anthropic-claude-opus-4-7",
    allowedBackendKeys: ["anthropic-claude-opus-4-7", "local-llama-3.1-8b-instruct"],
  };
  const request = {
    backendKey: "local-llama-3.1-8b-instruct",
    thresholds: { hallucinationRateMax: 0.015 },
    baselineMetrics: { hallucinationRate: 0.011 },
    baselineSetAt: T0,
    baselineEvaluationRunId: "run-7",
    supersededReason: null,
  };

  it("plans an insert with no supersede for the first baseline", () => {
    const decision = evaluateAiCalibrationPublication(capability, null, request, T0);
    expect(decision.ok).toBe(true);
    if (decision.ok !== true) return;
    expect(decision.plan.supersede).toBeNull();
    expect(decision.plan.insert.isCurrent).toBe(true);
  });

  it("requires a reason once there is an incumbent to supersede", () => {
    const decision = evaluateAiCalibrationPublication(
      capability,
      { id: "calib-1", backendKey: "local-llama-3.1-8b-instruct" },
      request,
      T0,
    );
    expect(decision).toMatchObject({
      ok: false,
      code: "AI_CALIBRATION_SUPERSEDE_REASON_REQUIRED",
    });
  });

  it("plans both writes when the reason is given", () => {
    const decision = evaluateAiCalibrationPublication(
      capability,
      { id: "calib-1", backendKey: "local-llama-3.1-8b-instruct" },
      { ...request, supersededReason: "new golden-set run" },
      T0,
    );
    expect(decision.ok).toBe(true);
    if (decision.ok !== true) return;
    expect(decision.plan.supersede).toEqual({
      calibrationId: "calib-1",
      supersededReason: "new golden-set run",
      supersededAt: T0,
    });
  });

  it("refuses a backend the capability may never route to", () => {
    const decision = evaluateAiCalibrationPublication(
      capability,
      null,
      { ...request, backendKey: "local-mistral-7b-instruct" },
      T0,
    );
    expect(decision).toMatchObject({ ok: false, code: "AI_CALIBRATION_BACKEND_NOT_ALLOWED" });
  });

  it("refuses a baseline with no evaluation run behind it", () => {
    const decision = evaluateAiCalibrationPublication(
      capability,
      null,
      { ...request, baselineEvaluationRunId: null },
      T0,
    );
    expect(decision).toMatchObject({
      ok: false,
      code: "AI_CALIBRATION_EVALUATION_RUN_REQUIRED",
    });
  });
});

// ── §5.3 / W4 tenant opt-in ────────────────────────────────────────────────────────────────────────

const cloudCapability: AiOptInCapabilitySnapshot = {
  riskTier: "high",
  posture: { kind: "generally_available" },
  localBackendAvailable: true,
  cloudBackendAvailable: true,
};

const fullEvidence: AiOptInResolvedEvidence = {
  baaResolved: true,
  baaExpiresAt: "2027-01-01T00:00:00.000Z",
  zdrContractOnRecord: true,
  clinicalReviewerHasSafetyLeadRole: true,
};

const fullRequest: AiTenantOptInRequest = {
  routingMode: "default",
  pilotEnrollment: false,
  acknowledgments: {
    baaReference: "BAA-2026-014",
    zdrContractReference: "ZDR-ANTHROPIC-88",
    clinicalReviewerMembershipId: "mem-reviewer",
    clinicalReviewerAttestationText: "reviewed the calibration; appropriate for our population",
    disclosureAccountingAcknowledged: true,
    calibrationTradeOffAcknowledged: null,
  },
};

describe("§5.3 / W4 tenant opt-in", () => {
  it("accepts a complete high-risk cloud opt-in and freezes the routing snapshot", () => {
    const decision = evaluateAiTenantOptIn(
      cloudCapability,
      null,
      fullRequest,
      fullEvidence,
      "prefer_cloud",
      T0,
    );
    expect(decision.ok).toBe(true);
    if (decision.ok !== true) return;
    expect(decision.patch.status).toBe("active");
    expect(decision.patch.optedInAt).toBe(T0);
    expect(decision.patch.routingPreferenceSnapshot).toBe("prefer_cloud");
    expect(decision.cloudReachable).toBe(true);
  });

  it("refuses a high-risk opt-in with no §164.528 acknowledgment", () => {
    const decision = evaluateAiTenantOptIn(
      cloudCapability,
      null,
      {
        ...fullRequest,
        acknowledgments: {
          ...fullRequest.acknowledgments,
          disclosureAccountingAcknowledged: false,
        },
      },
      fullEvidence,
      "prefer_cloud",
      T0,
    );
    expect(decision).toMatchObject({ ok: false, code: "AI_OPT_IN_ACKNOWLEDGMENT_MISSING" });
  });

  it("does NOT demand that acknowledgment of a medium-risk capability", () => {
    const decision = evaluateAiTenantOptIn(
      { ...cloudCapability, riskTier: "medium" },
      null,
      {
        ...fullRequest,
        acknowledgments: {
          ...fullRequest.acknowledgments,
          disclosureAccountingAcknowledged: false,
        },
      },
      fullEvidence,
      "prefer_cloud",
      T0,
    );
    expect(decision.ok).toBe(true);
  });

  it("refuses an unresolved BAA and an expired one with DIFFERENT codes", () => {
    expect(
      evaluateAiTenantOptIn(
        cloudCapability,
        null,
        fullRequest,
        { ...fullEvidence, baaResolved: false },
        "prefer_cloud",
        T0,
      ),
    ).toMatchObject({ ok: false, code: "AI_OPT_IN_BAA_UNRESOLVED" });
    expect(
      evaluateAiTenantOptIn(
        cloudCapability,
        null,
        fullRequest,
        { ...fullEvidence, baaExpiresAt: "2025-12-31T00:00:00.000Z" },
        "prefer_cloud",
        T0,
      ),
    ).toMatchObject({ ok: false, code: "AI_OPT_IN_BAA_EXPIRED" });
  });

  it("refuses when the named clinical reviewer is not a clinical_safety_lead", () => {
    const decision = evaluateAiTenantOptIn(
      cloudCapability,
      null,
      fullRequest,
      { ...fullEvidence, clinicalReviewerHasSafetyLeadRole: false },
      "prefer_cloud",
      T0,
    );
    expect(decision).toMatchObject({ ok: false, code: "AI_OPT_IN_CLINICAL_REVIEWER_INVALID" });
  });

  it("drops the vendor-disclosure gate on a local_only route, and keeps the reviewer's", () => {
    // AI Governance §10.9: "Your agency's PHI is not transmitted to any AI vendor." No BAA reference,
    // no ZDR contract, no resolved evidence for either — and the opt-in still succeeds…
    const localOnly = evaluateAiTenantOptIn(
      cloudCapability,
      null,
      {
        ...fullRequest,
        routingMode: "local_only",
        acknowledgments: {
          ...fullRequest.acknowledgments,
          baaReference: null,
          zdrContractReference: null,
          calibrationTradeOffAcknowledged: "local Llama: hallucination ≤1.5%, acceptance ≥80%",
        },
      },
      { ...fullEvidence, baaResolved: false, zdrContractOnRecord: false },
      "prefer_cloud",
      T0,
    );
    expect(localOnly.ok).toBe(true);
    if (localOnly.ok !== true) return;
    expect(localOnly.cloudReachable).toBe(false);
    expect(localOnly.patch.routingPreferenceSnapshot).toBe("local_only");

    // …while the clinical reviewer's attestation is about the CAPABILITY, so it still binds.
    const noReviewer = evaluateAiTenantOptIn(
      cloudCapability,
      null,
      {
        ...fullRequest,
        routingMode: "local_only",
        acknowledgments: {
          ...fullRequest.acknowledgments,
          baaReference: null,
          zdrContractReference: null,
          calibrationTradeOffAcknowledged: "trade-off shown",
        },
      },
      { ...fullEvidence, clinicalReviewerHasSafetyLeadRole: false },
      "prefer_cloud",
      T0,
    );
    expect(noReviewer).toMatchObject({ ok: false, code: "AI_OPT_IN_CLINICAL_REVIEWER_INVALID" });
  });

  it("demands §10.10's trade-off body exactly when the tenant chose a local route", () => {
    const missing = evaluateAiTenantOptIn(
      cloudCapability,
      null,
      { ...fullRequest, routingMode: "prefer_local" },
      fullEvidence,
      "prefer_cloud",
      T0,
    );
    expect(missing).toMatchObject({ ok: false, code: "AI_OPT_IN_ACKNOWLEDGMENT_MISSING" });
    // The same submission on the default cloud route is complete.
    expect(
      evaluateAiTenantOptIn(cloudCapability, null, fullRequest, fullEvidence, "prefer_cloud", T0)
        .ok,
    ).toBe(true);
  });

  it("refuses local_only for a capability with no local backend (§10.8)", () => {
    const decision = evaluateAiTenantOptIn(
      { ...cloudCapability, localBackendAvailable: false },
      null,
      { ...fullRequest, routingMode: "local_only" },
      fullEvidence,
      "prefer_cloud",
      T0,
    );
    expect(decision).toMatchObject({ ok: false, code: "AI_OPT_IN_ROUTING_MODE_UNSUPPORTED" });
  });

  it("refuses cloud_only for a capability with no cloud backend (§10.8)", () => {
    const decision = evaluateAiTenantOptIn(
      { ...cloudCapability, cloudBackendAvailable: false },
      null,
      fullRequest,
      fullEvidence,
      "cloud_only",
      T0,
    );
    expect(decision).toMatchObject({ ok: false, code: "AI_OPT_IN_ROUTING_MODE_UNSUPPORTED" });
  });

  it("maps the §5.3.1 routing selector onto the §3.2.6 preference vocabulary", () => {
    expect(aiResolveRoutingPreference("default", "cloud_only")).toBe("cloud_only");
    expect(aiResolveRoutingPreference("prefer_local", "cloud_only")).toBe("prefer_local");
    expect(aiResolveRoutingPreference("local_only", "prefer_cloud")).toBe("local_only");
    expect(aiCloudReachableUnder("local_only", true)).toBe(false);
    expect(aiCloudReachableUnder("prefer_local", true)).toBe(true);
    expect(aiCloudReachableUnder("prefer_cloud", false)).toBe(false);
  });
});

describe("§2.2 offerability — which postures accept an opt-in", () => {
  it("lets a pilot tenant into PILOT and nobody else", () => {
    expect(aiTenantOptInOfferable({ kind: "pilot_tenants_only" }, null, true).ok).toBe(true);
    expect(aiTenantOptInOfferable({ kind: "pilot_tenants_only" }, null, false)).toMatchObject({
      ok: false,
      code: "AI_OPT_IN_CAPABILITY_NOT_OFFERABLE",
    });
  });

  it("lets a DEPRECATED capability be resumed but never newly entered", () => {
    const posture = { kind: "existing_opt_ins_only" } as const;
    expect(aiTenantOptInOfferable(posture, "active", false).ok).toBe(true);
    expect(aiTenantOptInOfferable(posture, "paused", false).ok).toBe(true);
    // A tenant that WITHDREW cannot re-enter a capability the platform is retiring…
    expect(aiTenantOptInOfferable(posture, "opted_out", false)).toMatchObject({ ok: false });
    // …and neither can one that never had a row (§3.2.6's default makes those two states different).
    expect(aiTenantOptInOfferable(posture, null, false)).toMatchObject({ ok: false });
  });

  it("refuses every unavailable posture", () => {
    expect(
      aiTenantOptInOfferable(
        { kind: "unavailable", reason: "lifecycle_state_retired" },
        "active",
        true,
      ),
    ).toMatchObject({ ok: false, code: "AI_OPT_IN_CAPABILITY_NOT_OFFERABLE" });
  });
});

describe("§10.6 withdrawal and pause", () => {
  it("withdraws with no reason at all", () => {
    const decision = evaluateAiTenantOptInWithdrawal("active", null, T0);
    expect(decision.ok).toBe(true);
    if (decision.ok !== true) return;
    expect(decision.patch).toMatchObject({
      status: "opted_out",
      optedOutAt: T0,
      optedOutReason: null,
    });
  });

  it("refuses a second withdrawal so the instant consent ended is not overwritten", () => {
    expect(evaluateAiTenantOptInWithdrawal("opted_out", null, T0)).toMatchObject({
      ok: false,
      code: "AI_OPT_IN_ALREADY_INACTIVE",
    });
    expect(evaluateAiTenantOptInWithdrawal(null, null, T0)).toMatchObject({
      ok: false,
      code: "AI_OPT_IN_NOT_FOUND",
    });
  });

  it("pauses only an active opt-in, and only with a reason", () => {
    expect(evaluateAiTenantOptInPause("active", "vendor incident", T0).ok).toBe(true);
    expect(evaluateAiTenantOptInPause("active", "  ", T0)).toMatchObject({ ok: false });
    expect(evaluateAiTenantOptInPause("paused", "again", T0)).toMatchObject({
      ok: false,
      code: "AI_OPT_IN_ALREADY_INACTIVE",
    });
  });
});

// ── §5.4 clinician opt-out ─────────────────────────────────────────────────────────────────────────

describe("§5.4 clinician opt-out", () => {
  it("records an opt-out with no reason", () => {
    const decision = evaluateAiClinicianOptOut({ clinicianOptOutSupported: true }, null, null, T0);
    expect(decision.ok).toBe(true);
    if (decision.ok !== true) return;
    expect(decision.alreadyOptedOut).toBe(false);
    expect(decision.patch).toMatchObject({ optedOut: true, reason: null, revertedAt: null });
  });

  it("treats a second opt-out as a no-op, not a conflict", () => {
    const decision = evaluateAiClinicianOptOut(
      { clinicianOptOutSupported: true },
      { id: "oo-1", optedOutAt: T0 },
      "again",
      T0,
    );
    expect(decision.ok).toBe(true);
    if (decision.ok !== true) return;
    expect(decision.alreadyOptedOut).toBe(true);
    expect(decision.patch).toBeNull();
  });

  it("refuses on a capability that does not support a personal opt-out", () => {
    expect(
      evaluateAiClinicianOptOut({ clinicianOptOutSupported: false }, null, null, T0),
    ).toMatchObject({ ok: false, code: "AI_OPT_OUT_NOT_SUPPORTED" });
  });

  it("reverts by stamping the live row, and refuses when there is nothing live", () => {
    const decision = evaluateAiClinicianOptOutRevert(
      { id: "oo-1", optedOutAt: T0 },
      "2026-02-01T00:00:00.000Z",
    );
    expect(decision.ok).toBe(true);
    if (decision.ok !== true) return;
    expect(decision.patch).toEqual({ optOutId: "oo-1", revertedAt: "2026-02-01T00:00:00.000Z" });
    expect(evaluateAiClinicianOptOutRevert(null, T0)).toMatchObject({
      ok: false,
      code: "AI_OPT_OUT_NOT_FOUND",
    });
  });
});

// ── the composed gate ──────────────────────────────────────────────────────────────────────────────

describe("the composed §2.2 + §5.3 + §5.4 gate", () => {
  const base = {
    lifecycleState: "APPROVED",
    tenantOptInRequired: true,
    tenantOptInStatus: "active",
    tenantPilotEnrollment: false,
    clinicianOptedOut: false,
  } as const;

  it("allows an approved capability with an active opt-in and no opt-out", () => {
    expect(aiGovernanceGateFor(base)).toMatchObject({ allowed: true });
  });

  it("refuses on the lifecycle FIRST, carrying the state, before asking about the tenant", () => {
    const decision = aiGovernanceGateFor({
      ...base,
      lifecycleState: "RETIRED",
      tenantOptInStatus: null,
    });
    expect(decision).toMatchObject({
      allowed: false,
      unavailable: {
        status: "capability_unavailable",
        reason: "lifecycle_state_retired",
        currentState: "RETIRED",
      },
    });
  });

  it("never leaks the governance state on a consent refusal", () => {
    const noOptIn = aiGovernanceGateFor({ ...base, tenantOptInStatus: null });
    expect(noOptIn).toMatchObject({
      allowed: false,
      unavailable: { reason: "tenant_not_opted_in" },
    });
    if (noOptIn.allowed !== false) return;
    expect(noOptIn.unavailable.currentState).toBeUndefined();

    const optedOut = aiGovernanceGateFor({ ...base, clinicianOptedOut: true });
    expect(optedOut).toMatchObject({
      allowed: false,
      unavailable: { reason: "clinician_opted_out" },
    });
    if (optedOut.allowed !== false) return;
    expect(optedOut.unavailable.currentState).toBeUndefined();
  });

  it("refuses a PILOT capability to an active-but-unenrolled tenant, naming the pilot", () => {
    expect(
      aiGovernanceGateFor({ ...base, lifecycleState: "PILOT", tenantPilotEnrollment: false }),
    ).toMatchObject({ allowed: false, unavailable: { reason: "not_enrolled_as_pilot_tenant" } });
    expect(
      aiGovernanceGateFor({ ...base, lifecycleState: "PILOT", tenantPilotEnrollment: true }),
    ).toMatchObject({ allowed: true });
  });

  it("keeps a DEPRECATED capability working for the tenant that was already active", () => {
    // D16 demotes precisely so in-flight use survives; the foreclosure is at the OPT-IN, not here.
    expect(aiGovernanceGateFor({ ...base, lifecycleState: "DEPRECATED" })).toMatchObject({
      allowed: true,
    });
    expect(
      aiGovernanceGateFor({
        ...base,
        lifecycleState: "DEPRECATED",
        tenantOptInStatus: "opted_out",
      }),
    ).toMatchObject({ allowed: false, unavailable: { reason: "tenant_not_opted_in" } });
  });

  it("refuses a PAUSED opt-in exactly like a withdrawn one", () => {
    expect(aiGovernanceGateFor({ ...base, tenantOptInStatus: "paused" })).toMatchObject({
      allowed: false,
      unavailable: { reason: "tenant_not_opted_in" },
    });
  });

  it("lets an opt-in-free capability through, but still honours the clinician", () => {
    expect(
      aiGovernanceGateFor({ ...base, tenantOptInRequired: false, tenantOptInStatus: null }),
    ).toMatchObject({ allowed: true });
    expect(
      aiGovernanceGateFor({
        ...base,
        tenantOptInRequired: false,
        tenantOptInStatus: null,
        clinicianOptedOut: true,
      }),
    ).toMatchObject({ allowed: false, unavailable: { reason: "clinician_opted_out" } });
  });
});
