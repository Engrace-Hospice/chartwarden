// Module 32 — §2.2 capability lifecycle FSM (M32-T01).
//
// The edge set is the governance contract: every promotion of a clinical AI capability passes through
// it, and a wrong edge is a capability reaching clinicians without the gate that was supposed to stop
// it. So the tests below assert the edges the diagram DOES have, and — the part that actually catches
// regressions — the plausible ones it does NOT.

import { describe, expect, it } from "vitest";

import { AI_CAPABILITY_LIFECYCLE_STATES } from "@chartwarden/types";
import {
  AI_LIFECYCLE_INITIAL_STATE,
  AI_LIFECYCLE_TRANSITIONS,
  aiConsumerPostureFor,
  aiEvaluationDatasetInvocationsAllowed,
  aiLifecycleNextStates,
  aiLifecycleTransition,
  aiSev1DemotionTarget,
  canAiLifecycleTransition,
} from "../src/lifecycle/state-machine";

describe("the §2.2 edge set", () => {
  it("registers a new capability into PROPOSED with a null from-state", () => {
    expect(AI_LIFECYCLE_INITIAL_STATE).toBe("PROPOSED");
    expect(canAiLifecycleTransition(null, "PROPOSED", "stage_1_proposal")).toBe(true);
    // Registration is the ONLY null-from edge — nothing else may materialise mid-ladder.
    expect(AI_LIFECYCLE_TRANSITIONS.filter((t) => t.fromState === null)).toHaveLength(1);
  });

  it("walks the full promotion ladder gate by gate", () => {
    expect(canAiLifecycleTransition("PROPOSED", "DESIGN_REVIEW", "stage_1_proposal")).toBe(true);
    expect(canAiLifecycleTransition("DESIGN_REVIEW", "EVALUATION", "stage_2_design_review")).toBe(
      true,
    );
    expect(canAiLifecycleTransition("EVALUATION", "PILOT", "stage_3_evaluation")).toBe(true);
    expect(canAiLifecycleTransition("PILOT", "APPROVED", "stage_4_pilot")).toBe(true);
    expect(canAiLifecycleTransition("APPROVED", "MONITORING", "stage_5_ga")).toBe(true);
    expect(canAiLifecycleTransition("DEPRECATED", "RETIRED", "retirement")).toBe(true);
  });

  it("refuses every skip — a capability cannot jump a gate", () => {
    expect(canAiLifecycleTransition("PROPOSED", "APPROVED", "stage_4_pilot")).toBe(false);
    expect(canAiLifecycleTransition("DESIGN_REVIEW", "PILOT", "stage_3_evaluation")).toBe(false);
    expect(canAiLifecycleTransition("EVALUATION", "APPROVED", "stage_4_pilot")).toBe(false);
    expect(canAiLifecycleTransition(null, "APPROVED", "stage_1_proposal")).toBe(false);
  });

  it("refuses a resurrection out of RETIRED", () => {
    expect(aiLifecycleNextStates("RETIRED")).toEqual([]);
    for (const state of AI_CAPABILITY_LIFECYCLE_STATES) {
      expect(canAiLifecycleTransition("RETIRED", state, "reapproval")).toBe(false);
    }
  });

  it("keys an edge on the TRIPLE, because neither the pair nor the kind identifies one alone", () => {
    // Same pair, two kinds, different accountability: a planned replacement vs a D16 safety demotion.
    expect(aiLifecycleTransition("APPROVED", "DEPRECATED", "deprecation")?.label).toMatch(
      /replaced/,
    );
    expect(aiLifecycleTransition("APPROVED", "DEPRECATED", "incident_demotion")?.label).toMatch(
      /SEV-1/,
    );
    // Same kind, two directions: the stage-3 gate approves forward and rejects backward.
    expect(canAiLifecycleTransition("EVALUATION", "PILOT", "stage_3_evaluation")).toBe(true);
    expect(canAiLifecycleTransition("EVALUATION", "PROPOSED", "stage_3_evaluation")).toBe(true);
  });

  it("returns null rather than throwing on an illegal triple — the caller decides the refusal", () => {
    expect(aiLifecycleTransition("PROPOSED", "RETIRED", "retirement")).toBeNull();
  });
});

describe("who signs, and on what evidence", () => {
  it("widens the signing set at Stage 2 and never narrows it below the AI Safety Owner", () => {
    for (const transition of AI_LIFECYCLE_TRANSITIONS) {
      expect(transition.requiredRoles).toContain("ai_safety_owner");
    }
    const stage2 = aiLifecycleTransition("DESIGN_REVIEW", "EVALUATION", "stage_2_design_review");
    expect([...(stage2?.requiredRoles ?? [])].sort()).toEqual([
      "ai_safety_owner",
      "clinical_reviewer",
      "privacy_officer",
    ]);
  });

  it("requires an evaluation run wherever D10's evidence is the gate", () => {
    expect(
      aiLifecycleTransition("EVALUATION", "PILOT", "stage_3_evaluation")?.requiresEvaluationRun,
    ).toBe(true);
    expect(aiLifecycleTransition("PILOT", "APPROVED", "stage_4_pilot")?.requiresEvaluationRun).toBe(
      true,
    );
    expect(aiLifecycleTransition("APPROVED", "APPROVED", "reapproval")?.requiresEvaluationRun).toBe(
      true,
    );
  });

  it("does NOT require one to demote — D16 has 60 seconds and an eval run takes hours", () => {
    for (const kind of ["deprecation", "incident_demotion", "retirement"] as const) {
      for (const t of AI_LIFECYCLE_TRANSITIONS.filter((x) => x.approvalKind === kind)) {
        expect(t.requiresEvaluationRun).toBe(false);
      }
    }
  });

  it("lets a reapproval be recorded without moving the capability (§3.2.1 next_reapproval_due_at)", () => {
    expect(canAiLifecycleTransition("APPROVED", "APPROVED", "reapproval")).toBe(true);
    expect(canAiLifecycleTransition("MONITORING", "MONITORING", "reapproval")).toBe(true);
    // A self-edge exists ONLY for reapproval; nothing else may no-op through the ledger.
    for (const t of AI_LIFECYCLE_TRANSITIONS.filter((x) => x.fromState === x.toState)) {
      expect(t.approvalKind).toBe("reapproval");
    }
  });
});

describe("D16 SEV-1 demotion", () => {
  it("demotes only what is actually reachable by a tenant", () => {
    expect(aiSev1DemotionTarget("APPROVED")).toBe("DEPRECATED");
    expect(aiSev1DemotionTarget("MONITORING")).toBe("DEPRECATED");
  });

  it("has nothing to demote below APPROVED or past DEPRECATED — the kill switch is the response", () => {
    for (const state of ["PROPOSED", "DESIGN_REVIEW", "EVALUATION", "PILOT"] as const) {
      expect(aiSev1DemotionTarget(state)).toBeNull();
    }
    expect(aiSev1DemotionTarget("DEPRECATED")).toBeNull();
    expect(aiSev1DemotionTarget("RETIRED")).toBeNull();
  });

  it("demotes to DEPRECATED, never RETIRED — the invocation history has to stay readable", () => {
    expect(aiSev1DemotionTarget("APPROVED")).not.toBe("RETIRED");
    expect(canAiLifecycleTransition("APPROVED", "RETIRED", "incident_demotion")).toBe(false);
  });
});

describe("the consumer-facing posture", () => {
  it("answers for every state — an unhandled state would fail OPEN at the seam", () => {
    for (const state of AI_CAPABILITY_LIFECYCLE_STATES) {
      expect(aiConsumerPostureFor(state).kind).toBeTruthy();
    }
  });

  it("collapses the three pre-pilot states into one refusal", () => {
    for (const state of ["PROPOSED", "DESIGN_REVIEW", "EVALUATION"] as const) {
      expect(aiConsumerPostureFor(state)).toEqual({
        kind: "unavailable",
        reason: "lifecycle_state_below_approved",
      });
    }
  });

  it("does not let a plain active opt-in reach a PILOT capability", () => {
    expect(aiConsumerPostureFor("PILOT")).toEqual({ kind: "pilot_tenants_only" });
  });

  it("treats APPROVED and MONITORING as consumer-identical", () => {
    expect(aiConsumerPostureFor("APPROVED")).toEqual(aiConsumerPostureFor("MONITORING"));
    expect(aiConsumerPostureFor("APPROVED")).toEqual({ kind: "generally_available" });
  });

  it("keeps a DEPRECATED capability serving its existing tenants — that is the point of D16", () => {
    // Demoting to a hard `unavailable` would cut clinicians off mid-use; DEPRECATED forecloses
    // RE-ACTIVATION and new opt-ins, not continuity.
    expect(aiConsumerPostureFor("DEPRECATED")).toEqual({ kind: "existing_opt_ins_only" });
  });

  it("refuses RETIRED with its own distinguishable reason", () => {
    expect(aiConsumerPostureFor("RETIRED")).toEqual({
      kind: "unavailable",
      reason: "lifecycle_state_retired",
    });
  });

  it("opens the evaluation-dataset path only where a golden set is the caller", () => {
    expect(aiEvaluationDatasetInvocationsAllowed("EVALUATION")).toBe(true);
    expect(aiEvaluationDatasetInvocationsAllowed("PILOT")).toBe(true);
    for (const state of ["PROPOSED", "DESIGN_REVIEW", "DEPRECATED", "RETIRED"] as const) {
      expect(aiEvaluationDatasetInvocationsAllowed(state)).toBe(false);
    }
  });
});
