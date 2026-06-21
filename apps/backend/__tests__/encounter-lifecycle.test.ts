// apps/backend/__tests__/encounter-lifecycle.test.ts — M8-T04 (§2.3 state machines, §2.7 validation,
// §2.8 side-effect rules). The pure M8 domain core: legal-transition graphs, enumerated guards (each
// raises its §2.7 machine-readable code), the addendum sub-machine, and the in-transaction side-effect
// lists. No DB — every cross-module fact (gate verdict, step-up freshness, F2F dual-write, eligible
// cosigner) is injected.
import { describe, expect, it } from "vitest";
import {
  ADDENDUM_GRAPH,
  ENCOUNTER_GRAPH,
  EncounterStateError,
  STEP_UP_MAX_AGE_SECONDS,
  checkCosignerEligibility,
  checkEligibleCosignerExists,
  checkEncounterDisciplinePair,
  checkF2fDualWrite,
  checkLateEntryReason,
  checkMutableForEdit,
  checkParentNotVoided,
  checkServiceDateAfterAdmission,
  checkServiceDateNotFuture,
  checkStepUpFresh,
  checkVersion,
  checkVocabVersion,
  checkVolunteerAssignment,
  daysBetween,
  planAddendumCreation,
  planDraftCreation,
  requiresCosignature,
  transitionAddendum,
  transitionEncounter,
} from "../src/modules/08-encounters/lifecycle/index";

/** Pull the outbox event names off a side-effect list (test helper). */
function outboxEvents(effects: ReadonlyArray<{ kind: string }>): string[] {
  return effects
    .filter((e): e is { kind: "outbox"; event: string } => e.kind === "outbox")
    .map((e) => e.event);
}

/** Assert that `fn` throws an EncounterStateError with the given §2.7 code. */
function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
    throw new Error(`expected EncounterStateError(${code}) — nothing thrown`);
  } catch (e) {
    expect(e).toBeInstanceOf(EncounterStateError);
    expect((e as EncounterStateError).code).toBe(code);
  }
}

const AT = "2026-06-21";

describe("calendar helper (§2.7)", () => {
  it("counts whole calendar days, signed", () => {
    expect(daysBetween("2026-01-01", "2026-01-31")).toBe(30);
    expect(daysBetween("2026-01-31", "2026-01-01")).toBe(-30);
    expect(daysBetween(AT, AT)).toBe(0);
  });
});

describe("Encounter state machine (§2.3)", () => {
  it("createDraft genesis emits audit + m8.encounter.created", () => {
    const fx = planDraftCreation();
    expect(fx.some((e) => e.kind === "audit")).toBe(true);
    expect(outboxEvents(fx)).toEqual(["m8.encounter.created"]);
  });

  it("rejects an illegal event from a state (nothing matches on a string)", () => {
    expectCode(
      () => transitionEncounter("signed", { type: "finalize", gatePreviewPassed: true, at: AT }),
      "ILLEGAL_TRANSITION",
    );
    expectCode(
      () => transitionEncounter("voided", { type: "recordCosignature", at: AT }),
      "ILLEGAL_TRANSITION",
    );
  });

  it("finalize: draft → finalized when the Layer-3 preview passes (persist + tier + outbox)", () => {
    const t = transitionEncounter("draft", { type: "finalize", gatePreviewPassed: true, at: AT });
    expect(t.to).toBe("finalized");
    expect(t.effects.map((e) => e.kind)).toEqual(
      expect.arrayContaining(["persist_assembled_output", "set_late_entry_tier"]),
    );
    expect(outboxEvents(t.effects)).toEqual(["m8.encounter.finalized"]);
  });

  it("finalize: a failed gate preview keeps the row in draft (COMPLIANCE_GATE_FAILED)", () => {
    expectCode(
      () => transitionEncounter("draft", { type: "finalize", gatePreviewPassed: false, at: AT }),
      "COMPLIANCE_GATE_FAILED",
    );
  });

  it("sign (RN): finalized → signed; writes primary signature + m8.encounter.signed; no cosign", () => {
    const t = transitionEncounter("finalized", {
      type: "sign",
      discipline: "rn",
      gatePassed: true,
      stepUpFresh: true,
      isF2f: false,
      f2fDualWriteSatisfied: false,
      eligibleCosignerExists: false,
      at: AT,
    });
    expect(t.to).toBe("signed");
    expect(t.effects).toContainEqual({ kind: "write_signature", signature: "primary" });
    expect(outboxEvents(t.effects)).toEqual(["m8.encounter.signed"]);
  });

  it("sign (LPN): finalized → cosign_pending; opens cosig request + routes (requires eligible RN)", () => {
    const t = transitionEncounter("finalized", {
      type: "sign",
      discipline: "lpn",
      gatePassed: true,
      stepUpFresh: true,
      isF2f: false,
      f2fDualWriteSatisfied: false,
      eligibleCosignerExists: true,
      at: AT,
    });
    expect(t.to).toBe("cosign_pending");
    expect(t.effects).toContainEqual({ kind: "open_cosignature_request" });
    expect(outboxEvents(t.effects)).toEqual(
      expect.arrayContaining(["m8.encounter.signed", "m8.encounter.cosignature_routed"]),
    );
  });

  it("sign (LPN): refused when no cosign-eligible RN exists on caseload (NO_ELIGIBLE_COSIGNER)", () => {
    expectCode(
      () =>
        transitionEncounter("finalized", {
          type: "sign",
          discipline: "lpn",
          gatePassed: true,
          stepUpFresh: true,
          isF2f: false,
          f2fDualWriteSatisfied: false,
          eligibleCosignerExists: false,
          at: AT,
        }),
      "NO_ELIGIBLE_COSIGNER",
    );
  });

  it("sign: stale step-up is refused before the gate is even consulted (STEP_UP_AUTH_REQUIRED)", () => {
    expectCode(
      () =>
        transitionEncounter("finalized", {
          type: "sign",
          discipline: "rn",
          gatePassed: false, // gate would also fail, but step-up is checked first
          stepUpFresh: false,
          isF2f: false,
          f2fDualWriteSatisfied: false,
          eligibleCosignerExists: false,
          at: AT,
        }),
      "STEP_UP_AUTH_REQUIRED",
    );
  });

  it("sign (F2F): refused without the M6 dual-write in the same tx (F2F_DUAL_WRITE_REQUIRED)", () => {
    expectCode(
      () =>
        transitionEncounter("finalized", {
          type: "sign",
          discipline: "md",
          gatePassed: true,
          stepUpFresh: true,
          isF2f: true,
          f2fDualWriteSatisfied: false,
          eligibleCosignerExists: false,
          at: AT,
        }),
      "F2F_DUAL_WRITE_REQUIRED",
    );
  });

  it("recordCosignature: cosign_pending → cosigned; writes cosignature + m8.encounter.cosigned", () => {
    const t = transitionEncounter("cosign_pending", { type: "recordCosignature", at: AT });
    expect(t.to).toBe("cosigned");
    expect(t.effects).toContainEqual({ kind: "write_signature", signature: "cosignature" });
    expect(outboxEvents(t.effects)).toEqual(["m8.encounter.cosigned"]);
  });

  it("void: draft → voided for an admin with a ≥40-char reason; emits m8.encounter.voided", () => {
    const reason = "Wrong patient selected — duplicate draft created in error during intake.";
    const t = transitionEncounter("draft", { type: "void", isAdmin: true, reason, at: AT });
    expect(t.to).toBe("voided");
    expect(outboxEvents(t.effects)).toEqual(["m8.encounter.voided"]);
  });

  it("void: refused for a non-admin (VOID_NOT_PERMITTED) and for a short reason (VOID_REASON_TOO_SHORT)", () => {
    const longReason = "x".repeat(40);
    expectCode(
      () => transitionEncounter("draft", { type: "void", isAdmin: false, reason: longReason, at: AT }),
      "VOID_NOT_PERMITTED",
    );
    expectCode(
      () => transitionEncounter("draft", { type: "void", isAdmin: true, reason: "too short", at: AT }),
      "VOID_REASON_TOO_SHORT",
    );
  });

  it("the graph terminalises signed/cosigned/voided (no outbound events)", () => {
    expect(ENCOUNTER_GRAPH.signed).toEqual([]);
    expect(ENCOUNTER_GRAPH.cosigned).toEqual([]);
    expect(ENCOUNTER_GRAPH.voided).toEqual([]);
  });

  it("requiresCosignature is true only for lpn/chha", () => {
    expect(requiresCosignature("lpn")).toBe(true);
    expect(requiresCosignature("chha")).toBe(true);
    expect(requiresCosignature("rn")).toBe(false);
    expect(requiresCosignature("md")).toBe(false);
  });
});

describe("Addendum sub-machine (§2.3)", () => {
  it("createAddendum genesis emits audit only (no outbox until sign)", () => {
    const fx = planAddendumCreation();
    expect(fx).toEqual([{ kind: "audit" }]);
  });

  it("draft → finalized → signed; sign emits m8.encounter.addendum_signed", () => {
    const fin = transitionAddendum("draft", { type: "finalize", gatePreviewPassed: true, at: AT });
    expect(fin.to).toBe("finalized");
    const signed = transitionAddendum("finalized", { type: "sign", gatePassed: true, stepUpFresh: true, at: AT });
    expect(signed.to).toBe("signed");
    expect(signed.effects).toContainEqual({ kind: "write_signature", signature: "addendum" });
    expect(outboxEvents(signed.effects)).toEqual(["m8.encounter.addendum_signed"]);
  });

  it("rejects an illegal addendum event (ILLEGAL_TRANSITION)", () => {
    expectCode(
      () => transitionAddendum("signed", { type: "sign", gatePassed: true, stepUpFresh: true, at: AT }),
      "ILLEGAL_TRANSITION",
    );
    expect(ADDENDUM_GRAPH.signed).toEqual([]);
  });
});

describe("§2.7 synchronous validators", () => {
  it("checkEncounterDisciplinePair enforces the §2.2 legal-pair matrix", () => {
    expect(() => checkEncounterDisciplinePair({ encounterType: "routine_visit", discipline: "rn" })).not.toThrow();
    expectCode(
      () => checkEncounterDisciplinePair({ encounterType: "face_to_face", discipline: "rn" }),
      "INVALID_ENCOUNTER_DISCIPLINE_PAIR",
    );
  });

  it("checkServiceDateNotFuture / checkServiceDateAfterAdmission", () => {
    expect(() => checkServiceDateNotFuture({ serviceDate: "2026-06-20", today: AT })).not.toThrow();
    expectCode(() => checkServiceDateNotFuture({ serviceDate: "2026-06-22", today: AT }), "SERVICE_DATE_IN_FUTURE");
    expect(() =>
      checkServiceDateAfterAdmission({ serviceDate: AT, admissionActivationDate: "2026-06-01" }),
    ).not.toThrow();
    expectCode(
      () => checkServiceDateAfterAdmission({ serviceDate: "2026-05-31", admissionActivationDate: "2026-06-01" }),
      "SERVICE_DATE_BEFORE_ADMISSION",
    );
  });

  it("checkLateEntryReason: required ≥40 chars only for late tiers", () => {
    expect(() => checkLateEntryReason({ tier: "normal", reason: null })).not.toThrow();
    expectCode(
      () => checkLateEntryReason({ tier: "late_entry", reason: "too short" }),
      "LATE_ENTRY_REASON_REQUIRED",
    );
    expect(() =>
      checkLateEntryReason({ tier: "significant_late_entry", reason: "x".repeat(40) }),
    ).not.toThrow();
  });

  it("checkVolunteerAssignment: only volunteer_visit needs an active assignment", () => {
    expect(() =>
      checkVolunteerAssignment({ encounterType: "routine_visit", hasActiveVolunteerAssignment: false }),
    ).not.toThrow();
    expectCode(
      () => checkVolunteerAssignment({ encounterType: "volunteer_visit", hasActiveVolunteerAssignment: false }),
      "NO_VOLUNTEER_ASSIGNMENT",
    );
  });

  it("checkStepUpFresh: enforces the D13 5-minute window", () => {
    expect(() => checkStepUpFresh({ stepUpAgeSeconds: STEP_UP_MAX_AGE_SECONDS })).not.toThrow();
    expectCode(() => checkStepUpFresh({ stepUpAgeSeconds: STEP_UP_MAX_AGE_SECONDS + 1 }), "STEP_UP_AUTH_REQUIRED");
    expectCode(() => checkStepUpFresh({ stepUpAgeSeconds: null }), "STEP_UP_AUTH_REQUIRED");
  });

  it("checkF2fDualWrite / checkEligibleCosignerExists are discipline/flag conditional", () => {
    expect(() => checkF2fDualWrite({ isF2f: false, faceToFaceEncounterIdPresent: false })).not.toThrow();
    expectCode(
      () => checkF2fDualWrite({ isF2f: true, faceToFaceEncounterIdPresent: false }),
      "F2F_DUAL_WRITE_REQUIRED",
    );
    expect(() => checkEligibleCosignerExists({ discipline: "rn", eligibleCosignerExists: false })).not.toThrow();
    expectCode(
      () => checkEligibleCosignerExists({ discipline: "chha", eligibleCosignerExists: false }),
      "NO_ELIGIBLE_COSIGNER",
    );
  });

  it("checkCosignerEligibility requires permission + RN + caseload", () => {
    expect(() =>
      checkCosignerEligibility({ hasCosignPermission: true, isRn: true, onCaseload: true }),
    ).not.toThrow();
    expectCode(
      () => checkCosignerEligibility({ hasCosignPermission: true, isRn: false, onCaseload: true }),
      "NOT_COSIGN_ELIGIBLE",
    );
  });

  it("checkVocabVersion / checkVersion / checkParentNotVoided / checkMutableForEdit", () => {
    expectCode(
      () => checkVocabVersion({ pinnedVersionId: "v1", activeVersionId: "v2" }),
      "VOCAB_VERSION_MISMATCH",
    );
    expectCode(() => checkVersion({ expected: 3, actual: 4 }), "VERSION_MISMATCH");
    expectCode(() => checkParentNotVoided({ parentStatus: "voided" }), "PARENT_VOIDED");
    expect(() => checkParentNotVoided({ parentStatus: "signed" })).not.toThrow();
    expectCode(() => checkMutableForEdit({ status: "signed" }), "IMMUTABLE_AFTER_SIGN");
    expect(() => checkMutableForEdit({ status: "draft" })).not.toThrow();
  });
});
