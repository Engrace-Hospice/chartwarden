// Module 32 — §3.2.12/W3 kill switch, §3.2.10/D9/W5 hallucination triage, §3.2.11/D10/W6 evaluation
// runs (M32-T05).
//
// Every rule with a plausible opposite has the opposite asserted: the kill switch resolving by
// specificity instead of disjunction, a tenant pause demoting a platform-shared capability, a critical
// report waiting for triage, an approval recorded against a failed run, a `post_incident` run standing
// in for the Stage-3 gate.

import { describe, expect, it } from "vitest";

import {
  AI_EVALUATION_STAGE_FOR_APPROVAL,
  AI_HALLUCINATION_TERMINAL_STATUSES,
  AI_KILL_SWITCH_SEV1_REASONS,
  aiEvaluationRunIsTerminal,
  aiEvaluationRunSupportsEdge,
  aiHallucinationFollowUpFor,
  aiHallucinationFollowUpPlanFor,
  aiHallucinationStatusIsTerminal,
  aiHallucinationTriageEdge,
  aiKillSwitchActorIsAutomated,
  aiKillSwitchDemotionPlanFor,
  aiKillSwitchFor,
  aiKillSwitchRequiresPlatformCredential,
  aiKillSwitchScopeOf,
  aiKillSwitchSeverityFor,
  canAiEvaluationRunTransition,
  evaluateAiEvaluationRunTransition,
  evaluateAiHallucinationFiling,
  evaluateAiHallucinationTriage,
  evaluateAiKillSwitchActivation,
  evaluateAiKillSwitchDeactivation,
} from "../src/index";
import type {
  AiEvaluationRunSnapshot,
  AiHallucinationFilingRequest,
  AiHallucinationReportSnapshot,
  AiKillSwitchActivationRequest,
  AiKillSwitchRowSnapshot,
} from "../src/index";

const T0 = "2026-08-15T12:00:00.000Z";
const ORG = "org-engrace";
const OTHER_ORG = "org-other";
const CAP = "cap-hearthnote";

function killRow(overrides: Partial<AiKillSwitchRowSnapshot> = {}): AiKillSwitchRowSnapshot {
  return {
    id: "aks-1",
    organizationId: ORG,
    capabilityId: CAP,
    active: true,
    reason: "manual_safety_pause",
    activationActorKind: "ai_safety_owner",
    activationActorMembershipId: "mem-1",
    activationMessage: "paused pending review",
    activatedAt: T0,
    ...overrides,
  };
}

function activation(
  overrides: Partial<AiKillSwitchActivationRequest> = {},
): AiKillSwitchActivationRequest {
  return {
    organizationId: ORG,
    capabilityId: CAP,
    reason: "manual_safety_pause",
    actorKind: "ai_safety_owner",
    actorMembershipId: "mem-1",
    activationMessage: "paused pending review",
    ...overrides,
  };
}

// ── §3.2.12 / W3 kill switch ───────────────────────────────────────────────────────────────────────

describe("kill switch — scope and the disjunction", () => {
  it("reads a NULL organization_id as the platform scope", () => {
    expect(aiKillSwitchScopeOf(null)).toBe("platform");
    expect(aiKillSwitchScopeOf(ORG)).toBe("tenant");
  });

  it("kills when EITHER the platform row or the tenant row is active", () => {
    expect(aiKillSwitchFor(ORG, [killRow()]).killed).toBe(true);
    expect(aiKillSwitchFor(ORG, [killRow({ id: "aks-p", organizationId: null })]).killed).toBe(
      true,
    );
    expect(aiKillSwitchFor(ORG, [killRow({ active: false })]).killed).toBe(false);
    expect(aiKillSwitchFor(ORG, []).killed).toBe(false);
  });

  it("does NOT let an inactive tenant row override an active platform kill (the specificity bug)", () => {
    const verdict = aiKillSwitchFor(ORG, [
      killRow({ id: "aks-p", organizationId: null, reason: "sev1_hallucination" }),
      killRow({ id: "aks-t", active: false }),
    ]);
    expect(verdict.killed).toBe(true);
    // and the PLATFORM row is named as the decider, so the operator learns "this is not just us"
    expect(verdict.scope).toBe("platform");
    expect(verdict.severity).toBe("sev1");
  });

  it("does NOT let an inactive platform row override an active tenant pause", () => {
    const verdict = aiKillSwitchFor(ORG, [
      killRow({ id: "aks-p", organizationId: null, active: false }),
      killRow({ id: "aks-t" }),
    ]);
    expect(verdict.killed).toBe(true);
    expect(verdict.scope).toBe("tenant");
    expect(verdict.severity).toBe("tenant");
  });

  it("ignores another tenant's active row", () => {
    expect(aiKillSwitchFor(ORG, [killRow({ id: "aks-x", organizationId: OTHER_ORG })]).killed).toBe(
      false,
    );
  });

  it("survives an active row whose reason column is NULL", () => {
    const verdict = aiKillSwitchFor(ORG, [killRow({ reason: null })]);
    expect(verdict.killed).toBe(true);
    expect(verdict.severity).toBeNull();
  });
});

describe("kill switch — severity and the platform credential", () => {
  it("makes a tenant pause its own class, never a demoted SEV", () => {
    expect(aiKillSwitchSeverityFor("tenant", "sev1_hallucination")).toBe("tenant");
  });

  it("raises SEV-1 only for the three clinical-harm reasons", () => {
    for (const reason of AI_KILL_SWITCH_SEV1_REASONS) {
      expect(aiKillSwitchSeverityFor("platform", reason)).toBe("sev1");
    }
    expect(aiKillSwitchSeverityFor("platform", "cost_cap_reached")).toBe("sev2");
    expect(aiKillSwitchSeverityFor("platform", "vendor_outage_exceeded_sla")).toBe("sev2");
  });

  it("requires the platform credential for a platform row and not for a tenant one", () => {
    expect(aiKillSwitchRequiresPlatformCredential("platform")).toBe(true);
    expect(aiKillSwitchRequiresPlatformCredential("tenant")).toBe(false);
  });

  it("classifies the four automated actor kinds", () => {
    expect(aiKillSwitchActorIsAutomated("automated_drift_monitor")).toBe(true);
    expect(aiKillSwitchActorIsAutomated("ai_safety_owner")).toBe(false);
  });
});

describe("kill switch — activation", () => {
  it("accepts a well-formed human activation and clears the previous resolution narrative", () => {
    const decision = evaluateAiKillSwitchActivation(activation(), null, "APPROVED", T0);
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    expect(decision.patch.activatedAt).toBe(T0);
    expect(decision.patch.deactivationMessage).toBeNull();
    expect(decision.patch.deactivatedAt).toBeNull();
  });

  it("refuses a second activation so the first incident's attribution survives", () => {
    const decision = evaluateAiKillSwitchActivation(activation(), killRow(), "APPROVED", T0);
    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.code).toBe("AI_KILL_SWITCH_ALREADY_ACTIVE");
  });

  it("activates over a DEACTIVATED row (the incident record is kept, not the switch)", () => {
    const decision = evaluateAiKillSwitchActivation(
      activation(),
      killRow({ active: false }),
      "APPROVED",
      T0,
    );
    expect(decision.ok).toBe(true);
  });

  it("refuses a human actor kind with no membership id", () => {
    const decision = evaluateAiKillSwitchActivation(
      activation({ actorMembershipId: null }),
      null,
      "APPROVED",
      T0,
    );
    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.code).toBe("AI_KILL_SWITCH_ACTOR_ATTRIBUTION_INVALID");
  });

  it("refuses an automated actor kind that names a person", () => {
    const decision = evaluateAiKillSwitchActivation(
      activation({ actorKind: "automated_drift_monitor", actorMembershipId: "mem-1" }),
      null,
      "APPROVED",
      T0,
    );
    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.code).toBe("AI_KILL_SWITCH_ACTOR_ATTRIBUTION_INVALID");
  });

  it("requires a human's own words but not a monitor's", () => {
    const human = evaluateAiKillSwitchActivation(
      activation({ activationMessage: "   " }),
      null,
      "APPROVED",
      T0,
    );
    expect(human.ok).toBe(false);
    if (!human.ok) expect(human.code).toBe("AI_KILL_SWITCH_ACTIVATION_MESSAGE_REQUIRED");

    const monitor = evaluateAiKillSwitchActivation(
      activation({
        actorKind: "automated_cost_watch",
        actorMembershipId: null,
        activationMessage: null,
        reason: "cost_cap_reached",
      }),
      null,
      "APPROVED",
      T0,
    );
    expect(monitor.ok).toBe(true);
  });
});

describe("kill switch — D16 demotion", () => {
  it("demotes an APPROVED capability on a SEV-1 platform kill", () => {
    const decision = evaluateAiKillSwitchActivation(
      activation({ organizationId: null, reason: "sev1_hallucination" }),
      null,
      "APPROVED",
      T0,
    );
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    expect(decision.severity).toBe("sev1");
    expect(decision.demotion).toMatchObject({ required: true, toState: "DEPRECATED" });
  });

  it("does NOT demote on a tenant pause, however severe the reason reads", () => {
    const decision = evaluateAiKillSwitchActivation(
      activation({ reason: "sev1_hallucination" }),
      null,
      "APPROVED",
      T0,
    );
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    expect(decision.severity).toBe("tenant");
    expect(decision.demotion.required).toBe(false);
  });

  it("has nothing to demote below APPROVED or past DEPRECATED", () => {
    expect(aiKillSwitchDemotionPlanFor("sev1", "PILOT", "sev1_hallucination").required).toBe(false);
    expect(
      aiKillSwitchDemotionPlanFor("sev1", "DEPRECATED", "sev1_hallucination").toState,
    ).toBeNull();
    expect(aiKillSwitchDemotionPlanFor("sev1", "MONITORING", "sev1_hallucination").toState).toBe(
      "DEPRECATED",
    );
  });

  it("does not demote on a SEV-2 platform kill", () => {
    expect(aiKillSwitchDemotionPlanFor("sev2", "APPROVED", "cost_cap_reached").required).toBe(
      false,
    );
  });
});

describe("kill switch — deactivation", () => {
  const lift = {
    organizationId: ORG,
    capabilityId: CAP,
    actorKind: "ai_safety_owner" as const,
    actorMembershipId: "mem-1",
    resolutionNarrative: "root cause fixed in prompt v3",
  };

  it("accepts a lift with a narrative and leaves the activation half alone", () => {
    const decision = evaluateAiKillSwitchDeactivation(lift, killRow(), T0);
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    expect(decision.patch.active).toBe(false);
    expect(decision.patch.deactivatedAt).toBe(T0);
    expect(Object.keys(decision.patch)).not.toContain("activationMessage");
  });

  it("refuses a lift with no resolution narrative (R8)", () => {
    const decision = evaluateAiKillSwitchDeactivation(
      { ...lift, resolutionNarrative: "  " },
      killRow(),
      T0,
    );
    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.code).toBe("AI_KILL_SWITCH_RESOLUTION_REQUIRED");
  });

  it("refuses a lift when nothing is active", () => {
    for (const current of [null, killRow({ active: false })]) {
      const decision = evaluateAiKillSwitchDeactivation(lift, current, T0);
      expect(decision.ok).toBe(false);
      if (!decision.ok) expect(decision.code).toBe("AI_KILL_SWITCH_NOT_ACTIVE");
    }
  });
});

// ── §3.2.10 / D9 / W5 hallucination triage ─────────────────────────────────────────────────────────

function filing(
  overrides: Partial<AiHallucinationFilingRequest> = {},
): AiHallucinationFilingRequest {
  return {
    organizationId: ORG,
    providerEntityId: "pe-1",
    locationId: null,
    invocationId: "ainv-1",
    capabilityId: CAP,
    reporterMembershipId: "mem-nurse",
    reporterRole: "registered_nurse",
    severity: "high",
    hallucinationKind: "wrong_dose",
    reporterNarrativeCipher: new Uint8Array([9, 9, 9]),
    ...overrides,
  };
}

function report(
  overrides: Partial<AiHallucinationReportSnapshot> = {},
): AiHallucinationReportSnapshot {
  return { id: "ahr-1", capabilityId: CAP, severity: "high", triageStatus: "open", ...overrides };
}

describe("hallucination filing (R18 / W5.1)", () => {
  it("files an open, unowned, undisposed report", () => {
    const decision = evaluateAiHallucinationFiling(filing(), T0);
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    expect(decision.patch).toEqual({
      triageStatus: "open",
      triageOwnerMembershipId: null,
      triageDisposition: null,
      mitigationActionRef: null,
      reportedAt: T0,
    });
    expect(decision.followUp.action).toBe("none");
  });

  it("accepts a report the clinician cannot trace to an invocation", () => {
    expect(evaluateAiHallucinationFiling(filing({ invocationId: null }), T0).ok).toBe(true);
  });

  it("refuses an empty narrative envelope", () => {
    const decision = evaluateAiHallucinationFiling(
      filing({ reporterNarrativeCipher: new Uint8Array() }),
      T0,
    );
    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.code).toBe("AI_HALLUCINATION_NARRATIVE_REQUIRED");
  });

  it("raises SEV-1 AT FILING for a critical report, without waiting for triage (D16's 60s)", () => {
    const decision = evaluateAiHallucinationFiling(filing({ severity: "critical" }), T0);
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    expect(decision.followUp).toEqual({
      action: "raise_sev1",
      killSwitchReason: "sev1_hallucination",
      demotesCapability: true,
    });
  });
});

describe("hallucination triage machine (D9)", () => {
  it("has no edge from open straight to closed — a report must be looked at", () => {
    expect(aiHallucinationTriageEdge("open", "closed")).toBeNull();
    expect(aiHallucinationTriageEdge("open", "investigating")).not.toBeNull();
    expect(aiHallucinationTriageEdge("investigating", "closed")).not.toBeNull();
  });

  it("treats escalation as terminal for M32, distinct from closed", () => {
    expect(AI_HALLUCINATION_TERMINAL_STATUSES).toEqual(["closed", "escalated_to_clinical_safety"]);
    expect(aiHallucinationStatusIsTerminal("escalated_to_clinical_safety")).toBe(true);
    expect(aiHallucinationTriageEdge("escalated_to_clinical_safety", "closed")).toBeNull();
  });

  it("offers escalation from every open status", () => {
    for (const from of ["open", "investigating", "root_cause_identified"] as const) {
      expect(aiHallucinationTriageEdge(from, "escalated_to_clinical_safety")).not.toBeNull();
    }
  });

  it("refuses a move out of a terminal status", () => {
    const decision = evaluateAiHallucinationTriage(
      {
        toStatus: "investigating",
        triageOwnerMembershipId: "mem-owner",
        disposition: null,
        mitigationActionRef: null,
        severity: "high",
      },
      report({ triageStatus: "closed" }),
      T0,
    );
    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.code).toBe("AI_HALLUCINATION_TRIAGE_INVALID_TRANSITION");
  });

  it("requires a disposition on the edges that claim the report was understood", () => {
    const decision = evaluateAiHallucinationTriage(
      {
        toStatus: "closed",
        triageOwnerMembershipId: "mem-owner",
        disposition: null,
        mitigationActionRef: null,
        severity: "low",
      },
      report({ triageStatus: "investigating" }),
      T0,
    );
    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.code).toBe("AI_HALLUCINATION_DISPOSITION_REQUIRED");
  });

  it("does not require one to start investigating", () => {
    expect(
      evaluateAiHallucinationTriage(
        {
          toStatus: "investigating",
          triageOwnerMembershipId: "mem-owner",
          disposition: null,
          mitigationActionRef: null,
          severity: "high",
        },
        report(),
        T0,
      ).ok,
    ).toBe(true);
  });

  it("requires an owner", () => {
    const decision = evaluateAiHallucinationTriage(
      {
        toStatus: "investigating",
        triageOwnerMembershipId: "  ",
        disposition: null,
        mitigationActionRef: null,
        severity: "high",
      },
      report(),
      T0,
    );
    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.code).toBe("AI_HALLUCINATION_TRIAGE_OWNER_REQUIRED");
  });

  it("stamps closedAt only on a terminal status", () => {
    const open = evaluateAiHallucinationTriage(
      {
        toStatus: "investigating",
        triageOwnerMembershipId: "mem-owner",
        disposition: null,
        mitigationActionRef: null,
        severity: "high",
      },
      report(),
      T0,
    );
    expect(open.ok && open.patch.closedAt).toBeNull();

    const escalated = evaluateAiHallucinationTriage(
      {
        toStatus: "escalated_to_clinical_safety",
        triageOwnerMembershipId: "mem-owner",
        disposition: null,
        mitigationActionRef: null,
        severity: "critical",
      },
      report(),
      T0,
    );
    expect(escalated.ok && escalated.patch.closedAt).toBe(T0);
  });
});

describe("hallucination follow-up (W5.7)", () => {
  it("maps each disposition to its one action", () => {
    expect(aiHallucinationFollowUpFor("model_rollback_required")).toBe("deprecate_capability");
    expect(aiHallucinationFollowUpFor("prompt_iteration_required")).toBe("notify_clinical_lead");
    expect(aiHallucinationFollowUpFor("edge_case_acknowledged")).toBe("none");
    expect(aiHallucinationFollowUpFor("false_alarm")).toBe("none");
  });

  it("kills at SEV-2, not SEV-1, when a non-critical report demands a rollback", () => {
    expect(aiHallucinationFollowUpPlanFor("high", "model_rollback_required")).toEqual({
      action: "deprecate_capability",
      killSwitchReason: "sev2_hallucination",
      demotesCapability: true,
    });
  });

  it("does not let a gentle disposition downgrade a critical report", () => {
    expect(aiHallucinationFollowUpPlanFor("critical", "false_alarm").action).toBe("raise_sev1");
  });

  it("iterates the prompt rather than deprecating a capability for a fault in our own artifact", () => {
    expect(aiHallucinationFollowUpPlanFor("high", "prompt_iteration_required")).toEqual({
      action: "notify_clinical_lead",
      killSwitchReason: null,
      demotesCapability: false,
    });
  });

  it("computes the plan from the TRIAGED severity, not the reported one", () => {
    const decision = evaluateAiHallucinationTriage(
      {
        toStatus: "investigating",
        triageOwnerMembershipId: "mem-owner",
        disposition: null,
        mitigationActionRef: null,
        severity: "critical",
      },
      report({ severity: "low" }),
      T0,
    );
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    expect(decision.followUp.action).toBe("raise_sev1");
  });
});

// ── §3.2.11 / D10 / W6 evaluation runs ─────────────────────────────────────────────────────────────

function run(overrides: Partial<AiEvaluationRunSnapshot> = {}): AiEvaluationRunSnapshot {
  return {
    id: "aer-1",
    capabilityId: CAP,
    backendId: "backend-1",
    stage: "stage_3_evaluation",
    status: "pending",
    decision: "no_decision",
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

describe("evaluation run lifecycle", () => {
  it("permits pending -> in_progress -> terminal, and pending -> aborted", () => {
    expect(canAiEvaluationRunTransition("pending", "in_progress")).toBe(true);
    expect(canAiEvaluationRunTransition("pending", "aborted")).toBe(true);
    expect(canAiEvaluationRunTransition("in_progress", "passed")).toBe(true);
  });

  it("refuses a re-queue of a finished run — a replay is a NEW run", () => {
    expect(canAiEvaluationRunTransition("passed", "in_progress")).toBe(false);
    expect(canAiEvaluationRunTransition("in_progress", "pending")).toBe(false);
    for (const s of ["passed", "failed", "aborted"] as const) {
      expect(aiEvaluationRunIsTerminal(s)).toBe(true);
    }
    expect(aiEvaluationRunIsTerminal("pending")).toBe(false);
  });

  it("stamps startedAt on entry to in_progress and completedAt on a terminal move", () => {
    const started = evaluateAiEvaluationRunTransition(
      { toStatus: "in_progress", decision: "no_decision", summaryMetrics: null },
      run(),
      T0,
    );
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.patch.startedAt).toBe(T0);
    expect(started.patch.completedAt).toBeNull();

    const finished = evaluateAiEvaluationRunTransition(
      { toStatus: "passed", decision: "approve_for_ga", summaryMetrics: { f1: 0.94 } },
      run({ status: "in_progress", startedAt: "2026-08-15T11:00:00.000Z" }),
      T0,
    );
    expect(finished.ok).toBe(true);
    if (!finished.ok) return;
    // The original start instant survives — a re-stamp would erase the queue latency.
    expect(finished.patch.startedAt).toBe("2026-08-15T11:00:00.000Z");
    expect(finished.patch.completedAt).toBe(T0);
  });

  it("refuses a decision on a run that has not finished", () => {
    const decision = evaluateAiEvaluationRunTransition(
      { toStatus: "in_progress", decision: "approve_for_ga", summaryMetrics: null },
      run(),
      T0,
    );
    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.code).toBe("AI_EVALUATION_DECISION_REQUIRES_TERMINAL_STATUS");
  });

  it("refuses an APPROVAL recorded against a failed run", () => {
    const decision = evaluateAiEvaluationRunTransition(
      { toStatus: "failed", decision: "approve_for_pilot", summaryMetrics: null },
      run({ status: "in_progress" }),
      T0,
    );
    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.code).toBe("AI_EVALUATION_DECISION_REQUIRES_PASS");
  });

  it("permits reject / recalibrate on a failed run", () => {
    for (const d of ["reject", "recalibrate_thresholds"] as const) {
      const decision = evaluateAiEvaluationRunTransition(
        { toStatus: "failed", decision: d, summaryMetrics: null },
        run({ status: "in_progress" }),
        T0,
      );
      expect(decision.ok).toBe(true);
    }
  });
});

describe("D10 evidence (aiEvaluationRunSupportsEdge)", () => {
  const passed = run({ status: "passed" });

  it("accepts a passed stage-3 run for the stage-3 gate", () => {
    expect(aiEvaluationRunSupportsEdge(passed, CAP, "stage_3_evaluation").ok).toBe(true);
  });

  it("refuses a run performed against a different capability", () => {
    const verdict = aiEvaluationRunSupportsEdge(passed, "cap-other", "stage_3_evaluation");
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.code).toBe("AI_EVALUATION_RUN_EVIDENCE_INVALID");
  });

  it("refuses a run that did not pass", () => {
    for (const status of ["pending", "in_progress", "failed", "aborted"] as const) {
      const verdict = aiEvaluationRunSupportsEdge(run({ status }), CAP, "stage_3_evaluation");
      expect(verdict.ok).toBe(false);
    }
  });

  it("refuses a post_incident run standing in for the stage-3 gate", () => {
    const verdict = aiEvaluationRunSupportsEdge(
      run({ status: "passed", stage: "post_incident" }),
      CAP,
      "stage_3_evaluation",
    );
    expect(verdict.ok).toBe(false);
  });

  it("accepts drift_response and post_incident runs as re-approval evidence", () => {
    for (const stage of ["reapproval", "drift_response", "post_incident"] as const) {
      expect(
        aiEvaluationRunSupportsEdge(run({ status: "passed", stage }), CAP, "reapproval").ok,
      ).toBe(true);
    }
  });

  it("cites nothing on the gates that take no evaluation evidence", () => {
    for (const kind of [
      "stage_1_proposal",
      "stage_2_design_review",
      "deprecation",
      "retirement",
      "incident_demotion",
    ] as const) {
      expect(AI_EVALUATION_STAGE_FOR_APPROVAL[kind]).toEqual([]);
      expect(aiEvaluationRunSupportsEdge(passed, CAP, kind).ok).toBe(false);
    }
  });
});
