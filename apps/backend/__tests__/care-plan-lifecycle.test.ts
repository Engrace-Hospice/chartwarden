// apps/backend/__tests__/care-plan-lifecycle.test.ts — M7-T03 (§2.2 lifecycle, §2.3 validation).
// The pure M7 care-plan domain core: the care_plan root + version + element machines, the §11 D5
// Required Signer Set quorum, and the §2.3 synchronous validation guards. No DB — every fact is injected.
import { describe, expect, it } from "vitest";
import {
  CarePlanStateError,
  checkDpoaGoalConsent,
  checkInitialHasProblem,
  checkInterventionFrequency,
  checkOptimisticConcurrency,
  checkPatientStatedGoalVerbatim,
  decideRecordSignature,
  isQuorumMet,
  openCarePlan,
  openCarePlanVersion,
  resolveRequiredSignerSet,
  transitionCarePlan,
  transitionCarePlanVersion,
  transitionGoal,
  transitionIntervention,
  transitionProblem,
} from "../src/modules/07-care-plan/lifecycle/index";
import {
  REQUIRED_SIGNER_SET_IDG_REVIEW,
  REQUIRED_SIGNER_SET_INITIAL,
} from "@wardenx/types";

/** Pull the outbox event names out of a side-effect list (test helper). */
function outboxEvents(effects: ReadonlyArray<{ kind: string }>): string[] {
  return effects.filter((e): e is { kind: "outbox"; event: string } => e.kind === "outbox").map((e) => e.event);
}

describe("Care plan root machine (§2.2.1)", () => {
  it("openCarePlan: created in draft, emits m7.care_plan.created", () => {
    const open = openCarePlan();
    expect(open.status).toBe("draft");
    expect(outboxEvents(open.effects)).toContain("m7.care_plan.created");
  });

  it("activate: draft → active requires a terminal active problem and stamps initial_signed_at", () => {
    const t = transitionCarePlan("draft", { type: "activate", hasTerminalActiveProblem: true, at: "2026-06-21T00:00:00Z" });
    expect(t.to).toBe("active");
    expect(t.effects.some((e) => e.kind === "flip_active_version")).toBe(true);
    expect(t.effects.some((e) => e.kind === "set_timestamp" && e.field === "initial_signed_at")).toBe(true);
  });

  it("activate without a terminal problem raises TERMINAL_PROBLEM_REQUIRED", () => {
    try {
      transitionCarePlan("draft", { type: "activate", hasTerminalActiveProblem: false, at: "2026-06-21T00:00:00Z" });
      expect.unreachable();
    } catch (e) {
      expect((e as CarePlanStateError).code).toBe("TERMINAL_PROBLEM_REQUIRED");
    }
  });

  it("reviseSigned keeps the plan active and flips the active version", () => {
    const t = transitionCarePlan("active", { type: "reviseSigned", at: "2026-06-22T00:00:00Z" });
    expect(t.to).toBe("active");
    expect(t.effects.some((e) => e.kind === "flip_active_version")).toBe(true);
  });

  it("discharge: active → discharged emits m7.care_plan.discharged", () => {
    const t = transitionCarePlan("active", { type: "discharge", reason: "death" });
    expect(t.to).toBe("discharged");
    expect(outboxEvents(t.effects)).toContain("m7.care_plan.discharged");
  });

  it("rejects an illegal event from a terminal state (nothing matches on a string)", () => {
    expect(() => transitionCarePlan("discharged", { type: "discharge", reason: "death" })).toThrow(CarePlanStateError);
  });
});

describe("Care plan version machine (§2.2.2)", () => {
  it("openCarePlanVersion: drafted, emits m7.care_plan.version_drafted", () => {
    const open = openCarePlanVersion("initial");
    expect(open.status).toBe("draft");
    expect(outboxEvents(open.effects)).toContain("m7.care_plan.version_drafted");
  });

  it("routeForSigning snapshots the floor Required Signer Set for the kind", () => {
    const t = transitionCarePlanVersion("draft", { type: "routeForSigning", kind: "initial", activeProblemCount: 2 });
    expect(t.to).toBe("in_review");
    const snap = t.effects.find((e) => e.kind === "snapshot");
    expect(snap).toBeDefined();
    expect(snap && snap.kind === "snapshot" && snap.requiredSignerSet).toEqual(REQUIRED_SIGNER_SET_INITIAL);
  });

  it("routeForSigning an initial version with zero problems raises INITIAL_VERSION_REQUIRES_PROBLEM", () => {
    try {
      transitionCarePlanVersion("draft", { type: "routeForSigning", kind: "initial", activeProblemCount: 0 });
      expect.unreachable();
    } catch (e) {
      expect((e as CarePlanStateError).code).toBe("INITIAL_VERSION_REQUIRES_PROBLEM");
    }
  });

  it("an idg_review version snapshots the full IDG quorum and does not require a problem to route", () => {
    const t = transitionCarePlanVersion("draft", { type: "routeForSigning", kind: "idg_review", activeProblemCount: 0 });
    const snap = t.effects.find((e) => e.kind === "snapshot");
    expect(snap && snap.kind === "snapshot" && snap.requiredSignerSet).toEqual(REQUIRED_SIGNER_SET_IDG_REVIEW);
  });

  it("recordSignature: a non-final signer keeps the version in_review", () => {
    const t = transitionCarePlanVersion("in_review", {
      type: "recordSignature",
      signerRole: "rn_case_manager",
      alreadySigned: [],
      requiredSignerSet: REQUIRED_SIGNER_SET_INITIAL,
      signedAt: "2026-06-21T10:00:00Z",
    });
    expect(t.to).toBe("in_review");
    expect(outboxEvents(t.effects)).not.toContain("m7.care_plan.version_signed");
  });

  it("recordSignature: the last required signer flips the version to signed + emits version_signed", () => {
    const t = transitionCarePlanVersion("in_review", {
      type: "recordSignature",
      signerRole: "hospice_physician",
      alreadySigned: ["rn_case_manager"],
      requiredSignerSet: REQUIRED_SIGNER_SET_INITIAL,
      signedAt: "2026-06-21T11:00:00Z",
    });
    expect(t.to).toBe("signed");
    expect(t.effects.some((e) => e.kind === "set_timestamp" && e.field === "signed_at")).toBe(true);
    expect(outboxEvents(t.effects)).toContain("m7.care_plan.version_signed");
  });

  it("editAfterFirstSignature (D8): returns to draft and clears prior signatures", () => {
    const t = transitionCarePlanVersion("in_review", { type: "editAfterFirstSignature" });
    expect(t.to).toBe("draft");
    expect(t.effects.some((e) => e.kind === "clear_signatures")).toBe(true);
  });

  it("returnForEdits clears signatures only when some were collected", () => {
    const withSigs = transitionCarePlanVersion("in_review", { type: "returnForEdits", hasSignatures: true });
    expect(withSigs.effects.some((e) => e.kind === "clear_signatures")).toBe(true);
    const noSigs = transitionCarePlanVersion("in_review", { type: "returnForEdits", hasSignatures: false });
    expect(noSigs.effects.some((e) => e.kind === "clear_signatures")).toBe(false);
  });

  it("supersede: signed → superseded", () => {
    expect(transitionCarePlanVersion("signed", { type: "supersede" }).to).toBe("superseded");
  });
});

describe("Required Signer Set quorum (§11 D5)", () => {
  it("resolveRequiredSignerSet maps idg_review to the IDG quorum and everything else to INITIAL", () => {
    expect(resolveRequiredSignerSet("initial")).toEqual(REQUIRED_SIGNER_SET_INITIAL);
    expect(resolveRequiredSignerSet("interim_revision")).toEqual(REQUIRED_SIGNER_SET_INITIAL);
    expect(resolveRequiredSignerSet("discharge")).toEqual(REQUIRED_SIGNER_SET_INITIAL);
    expect(resolveRequiredSignerSet("idg_review")).toEqual(REQUIRED_SIGNER_SET_IDG_REVIEW);
  });

  it("an either-of slot (hospice_physician|nurse_practitioner) is satisfied by either role", () => {
    expect(isQuorumMet(REQUIRED_SIGNER_SET_INITIAL, ["nurse_practitioner", "rn_case_manager"])).toBe(true);
    expect(isQuorumMet(REQUIRED_SIGNER_SET_INITIAL, ["hospice_physician", "rn_case_manager"])).toBe(true);
  });

  it("partial quorum is not met", () => {
    expect(isQuorumMet(REQUIRED_SIGNER_SET_INITIAL, ["rn_case_manager"])).toBe(false);
    expect(isQuorumMet(REQUIRED_SIGNER_SET_IDG_REVIEW, ["rn_case_manager", "msw", "chaplain"])).toBe(false);
    expect(isQuorumMet(REQUIRED_SIGNER_SET_IDG_REVIEW, ["rn_case_manager", "msw", "chaplain", "medical_director"])).toBe(true);
  });

  it("a role outside the set is SIGNER_ROLE_MISMATCH", () => {
    try {
      decideRecordSignature(REQUIRED_SIGNER_SET_INITIAL, [], "msw");
      expect.unreachable();
    } catch (e) {
      expect((e as CarePlanStateError).code).toBe("SIGNER_ROLE_MISMATCH");
    }
  });

  it("a second signer for an already-filled slot is DUPLICATE_SIGNER_ROLE", () => {
    try {
      decideRecordSignature(REQUIRED_SIGNER_SET_INITIAL, ["rn_case_manager"], "rn_case_manager");
      expect.unreachable();
    } catch (e) {
      expect((e as CarePlanStateError).code).toBe("DUPLICATE_SIGNER_ROLE");
    }
  });

  it("decideRecordSignature reports quorumMet on the last outstanding slot", () => {
    expect(decideRecordSignature(REQUIRED_SIGNER_SET_INITIAL, ["rn_case_manager"], "hospice_physician").quorumMet).toBe(true);
    expect(decideRecordSignature(REQUIRED_SIGNER_SET_INITIAL, [], "rn_case_manager").quorumMet).toBe(false);
  });
});

describe("Element machines (§2.2.3)", () => {
  it("problem: active → resolved requires a resolution note", () => {
    expect(transitionProblem("active", { type: "resolve", resolutionNote: "symptoms abated" }).to).toBe("resolved");
    try {
      transitionProblem("active", { type: "resolve", resolutionNote: "  " });
      expect.unreachable();
    } catch (e) {
      expect((e as CarePlanStateError).code).toBe("RESOLUTION_NOTE_REQUIRED");
    }
  });

  it("goal: in_progress → revised, then resumeRevised → in_progress", () => {
    expect(transitionGoal("in_progress", { type: "revise" }).to).toBe("revised");
    expect(transitionGoal("revised", { type: "resumeRevised" }).to).toBe("in_progress");
    expect(outboxEvents(transitionGoal("in_progress", { type: "markMet" }).effects)).toContain("m7.goal.met");
  });

  it("intervention: active → discontinued requires a reason", () => {
    expect(transitionIntervention("active", { type: "discontinue", reason: "goal met" }).to).toBe("discontinued");
    try {
      transitionIntervention("active", { type: "discontinue", reason: "" });
      expect.unreachable();
    } catch (e) {
      expect((e as CarePlanStateError).code).toBe("DISCONTINUE_REASON_REQUIRED");
    }
  });

  it("rejects an illegal element event (terminal status accepts nothing)", () => {
    expect(() => transitionProblem("resolved", { type: "deactivate" })).toThrow(CarePlanStateError);
    expect(() => transitionGoal("met", { type: "markNotMet" })).toThrow(CarePlanStateError);
  });
});

describe("Synchronous validation rules (§2.3)", () => {
  it("checkInitialHasProblem requires ≥1 problem", () => {
    expect(() => checkInitialHasProblem(1)).not.toThrow();
    expect(() => checkInitialHasProblem(0)).toThrow(CarePlanStateError);
  });

  it("a patient-stated goal must capture original_text and may not mutate it", () => {
    expect(() =>
      checkPatientStatedGoalVerbatim({ source: "patient_stated", originalText: "I want to go home", isUpdate: false, mutatingOriginalText: false }),
    ).not.toThrow();
    try {
      checkPatientStatedGoalVerbatim({ source: "patient_stated", originalText: "", isUpdate: false, mutatingOriginalText: false });
      expect.unreachable();
    } catch (e) {
      expect((e as CarePlanStateError).code).toBe("PATIENT_STATED_GOAL_VERBATIM");
    }
    expect(() =>
      checkPatientStatedGoalVerbatim({ source: "agent_stated", originalText: "x", isUpdate: true, mutatingOriginalText: true }),
    ).toThrow(CarePlanStateError);
    // A clinical goal is unconstrained.
    expect(() =>
      checkPatientStatedGoalVerbatim({ source: "clinical", originalText: null, isUpdate: false, mutatingOriginalText: false }),
    ).not.toThrow();
  });

  it("an agent-stated goal requires an active DPOA consent", () => {
    expect(() => checkDpoaGoalConsent("agent_stated", true)).not.toThrow();
    expect(() => checkDpoaGoalConsent("agent_stated", false)).toThrow(CarePlanStateError);
    expect(() => checkDpoaGoalConsent("clinical", false)).not.toThrow();
  });

  it("intervention frequency is required", () => {
    expect(() => checkInterventionFrequency("BID")).not.toThrow();
    expect(() => checkInterventionFrequency("  ")).toThrow(CarePlanStateError);
  });

  it("optimistic concurrency: a version mismatch is a 412 STALE_VERSION", () => {
    expect(() => checkOptimisticConcurrency(3, 3)).not.toThrow();
    try {
      checkOptimisticConcurrency(2, 3);
      expect.unreachable();
    } catch (e) {
      expect((e as CarePlanStateError).code).toBe("STALE_VERSION");
      expect((e as CarePlanStateError).statusCode).toBe(412);
    }
  });
});
