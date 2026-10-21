// apps/backend/__tests__/discipline-plans-lifecycle.test.ts — M15-T03 (§2.2 lifecycle, §2.3 validation,
// §7.1 supervisory cadence, §7.2/§7.3 initial clocks).
//
// The pure M15 discipline-plan domain core (no DB — every fact is injected) plus the two seam-consuming
// resolvers, exercised against registered fake M7 / M8 seams.
import { afterEach, describe, expect, it } from "vitest";
import { __resetSeamsForTest, registerSeam } from "../src/bootstrap/seams/registry";
import {
  assertParentElements,
  isAssessmentEncounterValid,
  isSupervisoryEncounterValid,
} from "../src/modules/15-discipline-care-plans/consumers/index";
import {
  DisciplinePlanStateError,
  type FinalizeReadiness,
  type SupervisoryVisitFacts,
  bootstrapDisciplinePlan,
  checkAuthoringDiscipline,
  checkDeclinationImmutable,
  checkDpoaGoalConsent,
  checkGoalTextVerbatim,
  checkOptimisticConcurrency,
  checkQuorumSatisfied,
  checkVolunteerOutOfScopeAcknowledged,
  computeNextSupervisoryDueAt,
  decideRecordSignature,
  decideRecordSupervisoryVisit,
  effectiveCadenceDays,
  evaluateInitialClock,
  evaluateSupervisoryCadence,
  hoursOverdue,
  isBootstrappedOnAdmissionActivated,
  isQuorumMet,
  isSupervisoryGateEngaged,
  openDisciplinePlanVersion,
  resolveRequiredSignerSet,
  transitionDisciplineAssessment,
  transitionDisciplineGoal,
  transitionDisciplineIntervention,
  transitionDisciplinePlan,
  transitionDisciplinePlanVersion,
} from "../src/modules/15-discipline-care-plans/lifecycle/index";

const ORG = "11111111-1111-1111-1111-111111111111";
const PATIENT = "22222222-2222-2222-2222-222222222222";
const PLAN = "33333333-3333-3333-3333-333333333333";
const AIDE = "44444444-4444-4444-4444-444444444444";
const RN = "55555555-5555-5555-5555-555555555555";
const ENCOUNTER = "66666666-6666-6666-6666-666666666666";
const T0 = "2026-03-01T15:00:00.000Z";

/**
 * Assert a guard raises the exact §2.3 / §4.2 machine-readable code. `ChartWardenError.message` is prose for
 * the clinician; the CODE is the contract the UI and the route table key off, so the tests assert on it.
 */
function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(DisciplinePlanStateError);
    expect((err as DisciplinePlanStateError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code} to be raised, but nothing was thrown`);
}

/** The async form (a seam-consuming resolver rejects with the same typed error). */
async function expectRejectCode(p: Promise<unknown>, code: string): Promise<void> {
  await expect(p).rejects.toMatchObject({ code });
}

/** Pull the outbox event names out of a side-effect list (test helper). */
function outboxEvents(effects: ReadonlyArray<{ kind: string }>): string[] {
  return effects
    .filter((e): e is { kind: "outbox"; event: string } => e.kind === "outbox")
    .map((e) => e.event);
}

/** Pull the timestamp fields a transition stamps (test helper). */
function timestampFields(effects: ReadonlyArray<{ kind: string }>): string[] {
  return effects
    .filter((e): e is { kind: "set_timestamp"; field: string } => e.kind === "set_timestamp")
    .map((e) => e.field);
}

const READY: FinalizeReadiness = {
  hasAideAssigned: true,
  hasSupervisingRn: true,
  hasActiveVolunteerAssignment: true,
  volunteerOutOfScopeAcknowledged: [
    "no_clinical_care",
    "no_medication_administration",
    "no_body_care",
    "no_off_premises_transport_without_separate_authorization",
    "no_clinical_document_signing",
  ],
};

// ── §2.2.1 plan root ────────────────────────────────────────────────────────────────────────────────

describe("Discipline-plan root machine (§2.2.1)", () => {
  it("bootstraps in draft, anchors the D10 clock, emits m15.plan.bootstrapped", () => {
    const open = bootstrapDisciplinePlan("msw_plan", T0);
    expect(open.status).toBe("draft");
    expect(open.initialAssessmentClockStartedAt).toBe(T0);
    expect(timestampFields(open.effects)).toContain("initial_assessment_clock_started_at");
    expect(outboxEvents(open.effects)).toContain("m15.plan.bootstrapped");
  });

  it("D10: the three clinical kinds bootstrap on admission.activated; volunteer_plan is lazy", () => {
    expect(isBootstrappedOnAdmissionActivated("aide_poc")).toBe(true);
    expect(isBootstrappedOnAdmissionActivated("msw_plan")).toBe(true);
    expect(isBootstrappedOnAdmissionActivated("spiritual_plan")).toBe(true);
    expect(isBootstrappedOnAdmissionActivated("volunteer_plan")).toBe(false);
  });

  it("§7.1 activate: an aide_poc arms next_supervisory_due_at at signature + 14 days", () => {
    const t = transitionDisciplinePlan("draft", { type: "activate", at: T0, kind: "aide_poc" });
    expect(t.to).toBe("active");
    const due = t.effects.find((e) => e.kind === "recompute_supervisory_due");
    expect(due).toEqual({
      kind: "recompute_supervisory_due",
      nextDueAt: "2026-03-15T15:00:00.000Z",
    });
  });

  it("activate: a non-aide kind arms no supervisory clock", () => {
    const t = transitionDisciplinePlan("draft", { type: "activate", at: T0, kind: "msw_plan" });
    expect(t.effects.some((e) => e.kind === "recompute_supervisory_due")).toBe(false);
  });

  it("openNextVersion → draft_revising, versionSigned → active (§7.7)", () => {
    expect(transitionDisciplinePlan("active", { type: "openNextVersion" }).to).toBe(
      "draft_revising",
    );
    expect(
      transitionDisciplinePlan("draft_revising", {
        type: "versionSigned",
        at: T0,
        kind: "msw_plan",
      }).to,
    ).toBe("active");
  });

  it("§7.11 discharge: legal from draft, active and draft_revising; emits m15.plan.discharged", () => {
    for (const from of ["draft", "active", "draft_revising"] as const) {
      const t = transitionDisciplinePlan(from, { type: "discharge", reason: "death", at: T0 });
      expect(t.to).toBe("discharged");
      expect(timestampFields(t.effects)).toContain("discharged_at");
      expect(outboxEvents(t.effects)).toContain("m15.plan.discharged");
    }
  });

  it("a discharged plan accepts nothing further", () => {
    expect(() => transitionDisciplinePlan("discharged", { type: "openNextVersion" })).toThrowError(
      DisciplinePlanStateError,
    );
  });
});

// ── §2.2.2 version + §3.5 D11 quorum ────────────────────────────────────────────────────────────────

describe("Discipline-plan version machine (§2.2.2)", () => {
  it("opens in draft with no outbox event (an abandoned draft is not a clinical fact)", () => {
    const open = openDisciplinePlanVersion("initial");
    expect(open.status).toBe("draft");
    expect(outboxEvents(open.effects)).toEqual([]);
  });

  it("finalize: seals the snapshot + the D11 quorum and stamps finalized_at", () => {
    const t = transitionDisciplinePlanVersion("draft", {
      type: "finalize",
      planKind: "msw_plan",
      versionKind: "initial",
      at: T0,
      readiness: READY,
    });
    expect(t.to).toBe("in_review");
    expect(timestampFields(t.effects)).toContain("finalized_at");
    const snap = t.effects.find((e) => e.kind === "snapshot");
    expect(snap).toEqual({
      kind: "snapshot",
      requiredSignerSet: resolveRequiredSignerSet("msw_plan", "initial"),
    });
  });

  it("§2.3 finalize readiness: an Aide POC without an assigned aide is refused", () => {
    expectCode(
      () =>
        transitionDisciplinePlanVersion("draft", {
          type: "finalize",
          planKind: "aide_poc",
          versionKind: "initial",
          at: T0,
          readiness: { ...READY, hasAideAssigned: false },
        }),
      "AIDE_ASSIGNMENT_REQUIRED",
    );
  });

  it("§2.3 finalize readiness: a Volunteer Plan without an active assignment is refused", () => {
    expectCode(
      () =>
        transitionDisciplinePlanVersion("draft", {
          type: "finalize",
          planKind: "volunteer_plan",
          versionKind: "initial",
          at: T0,
          readiness: { ...READY, hasActiveVolunteerAssignment: false },
        }),
      "VOLUNTEER_ASSIGNMENT_REQUIRED",
    );
  });

  it("§1.1 the CLOSED volunteer out-of-scope acknowledgment cannot be narrowed", () => {
    expect(() =>
      transitionDisciplinePlanVersion("draft", {
        type: "finalize",
        planKind: "volunteer_plan",
        versionKind: "initial",
        at: T0,
        readiness: { ...READY, volunteerOutOfScopeAcknowledged: ["no_clinical_care"] },
      }),
    ).toThrowError(/no_medication_administration/);
  });

  it("§7.1 the Aide POC quorum: the RN signature holds in_review; the CHHA acknowledgment signs it", () => {
    const set = resolveRequiredSignerSet("aide_poc", "initial");
    const first = transitionDisciplinePlanVersion("in_review", {
      type: "recordSignature",
      signerRole: "rn_case_manager",
      alreadySigned: [],
      requiredSignerSet: set,
      signedAt: T0,
    });
    expect(first.to).toBe("in_review");
    expect(outboxEvents(first.effects)).toEqual([]);

    const second = transitionDisciplinePlanVersion("in_review", {
      type: "recordSignature",
      signerRole: "chha_acknowledgment",
      alreadySigned: ["rn_case_manager"],
      requiredSignerSet: set,
      signedAt: T0,
    });
    expect(second.to).toBe("signed");
    expect(timestampFields(second.effects)).toContain("signed_at");
    expect(outboxEvents(second.effects)).toContain("m15.plan.version_signed");
  });

  it("the CHHA slot is an acknowledgment, not a cosignature (§3.5 D11)", () => {
    const set = resolveRequiredSignerSet("aide_poc", "initial");
    expect(decideRecordSignature(set, [], "chha_acknowledgment").isAcknowledgment).toBe(true);
    expect(decideRecordSignature(set, [], "rn_case_manager").isAcknowledgment).toBe(false);
  });

  it("a role outside the sealed set is 403; a duplicate role is 409", () => {
    const set = resolveRequiredSignerSet("msw_plan", "initial");
    expectCode(() => decideRecordSignature(set, [], "chaplain"), "SIGNER_ROLE_MISMATCH");
    expectCode(() => decideRecordSignature(set, ["msw"], "msw"), "DUPLICATE_SIGNER_ROLE");
  });

  it("checkQuorumSatisfied raises INSUFFICIENT_SIGNERS (412) until every slot is filled (§2.3)", () => {
    const set = resolveRequiredSignerSet("msw_plan", "initial");
    expect(isQuorumMet(set, ["msw"])).toBe(false);
    expectCode(() => checkQuorumSatisfied(set, ["msw"]), "INSUFFICIENT_SIGNERS");
    expect(isQuorumMet(set, ["msw", "rn_case_manager"])).toBe(true);
    expect(() => checkQuorumSatisfied(set, ["msw", "rn_case_manager"])).not.toThrow();
  });

  it("the discharge version carries an EMPTY quorum (system-actor signed, §2.2.2)", () => {
    expect(resolveRequiredSignerSet("spiritual_plan", "discharge")).toEqual([]);
  });

  it("editAfterFirstSignature returns the version to draft and clears the signatures (§2.2.2)", () => {
    const t = transitionDisciplinePlanVersion("in_review", { type: "editAfterFirstSignature" });
    expect(t.to).toBe("draft");
    expect(t.effects.some((e) => e.kind === "clear_signatures")).toBe(true);
  });

  it("returnForEdits only clears signatures when some were collected", () => {
    expect(
      transitionDisciplinePlanVersion("in_review", {
        type: "returnForEdits",
        hasSignatures: false,
      }).effects.some((e) => e.kind === "clear_signatures"),
    ).toBe(false);
  });

  it("a signed version supersedes; a superseded one accepts nothing", () => {
    const t = transitionDisciplinePlanVersion("signed", { type: "supersede", at: T0 });
    expect(t.to).toBe("superseded");
    expect(timestampFields(t.effects)).toContain("superseded_at");
    expect(() =>
      transitionDisciplinePlanVersion("superseded", { type: "supersede", at: T0 }),
    ).toThrowError(DisciplinePlanStateError);
  });
});

// ── §2.2.3 elements ─────────────────────────────────────────────────────────────────────────────────

describe("Discipline element machines (§2.2.3)", () => {
  it("goal: not_started → in_progress → met", () => {
    expect(transitionDisciplineGoal("not_started", { type: "start" }).to).toBe("in_progress");
    expect(transitionDisciplineGoal("in_progress", { type: "meet" }).to).toBe("met");
    expect(() => transitionDisciplineGoal("met", { type: "start" })).toThrowError(
      DisciplinePlanStateError,
    );
  });

  it("goal: a revision must supply revised_text; original_text is never overwritten (§2.3)", () => {
    expect(
      transitionDisciplineGoal("in_progress", { type: "revise", revisedText: "walk to the porch" })
        .to,
    ).toBe("revised");
    expectCode(
      () => transitionDisciplineGoal("in_progress", { type: "revise", revisedText: "  " }),
      "GOAL_TEXT_IMMUTABLE",
    );
  });

  it("intervention: discontinuation requires a reason", () => {
    expect(
      transitionDisciplineIntervention("active", { type: "discontinue", reason: "family declined" })
        .to,
    ).toBe("discontinued");
    expectCode(
      () => transitionDisciplineIntervention("active", { type: "discontinue", reason: "" }),
      "DISCONTINUE_REASON_REQUIRED",
    );
  });

  it("§7.2 assessment: a signed INITIAL assessment stamps the plan's D10 satisfier", () => {
    const t = transitionDisciplineAssessment("draft", {
      type: "sign",
      at: T0,
      isInitial: true,
      kind: "msw_psychosocial",
      sourceEncounterValid: null,
    });
    expect(t.to).toBe("signed");
    expect(timestampFields(t.effects)).toContain("initial_assessment_signed_at");
  });

  it("assessment: a non-initial sign does not touch the D10 satisfier", () => {
    const t = transitionDisciplineAssessment("draft", {
      type: "sign",
      at: T0,
      isInitial: false,
      kind: "msw_psychosocial",
      sourceEncounterValid: true,
    });
    expect(timestampFields(t.effects)).not.toContain("initial_assessment_signed_at");
  });

  it("§2.3 assessment: an unresolvable source encounter is INVALID_ENCOUNTER_REFERENCE", () => {
    expectCode(
      () =>
        transitionDisciplineAssessment("draft", {
          type: "sign",
          at: T0,
          isInitial: true,
          kind: "msw_psychosocial",
          sourceEncounterValid: false,
        }),
      "INVALID_ENCOUNTER_REFERENCE",
    );
  });

  it("assessment: amendment is append-only and needs a reason; emits the M22/M30 event", () => {
    const t = transitionDisciplineAssessment("signed", {
      type: "amend",
      reason: "corrected the household composition",
      at: T0,
    });
    expect(t.to).toBe("amended");
    expect(outboxEvents(t.effects)).toContain("m15.discipline_assessment.amended");
    expectCode(
      () => transitionDisciplineAssessment("signed", { type: "amend", reason: " ", at: T0 }),
      "AMENDMENT_REASON_REQUIRED",
    );
  });
});

// ── §2.2.4 / §7.1 supervisory cadence ───────────────────────────────────────────────────────────────

describe("Aide supervisory cadence (§2.2.4 / §7.1)", () => {
  const FACTS: SupervisoryVisitFacts = {
    planStatus: "active",
    planAideMembershipId: AIDE,
    planSupervisingRnMembershipId: RN,
    aideMembershipId: AIDE,
    supervisingRnMembershipId: RN,
    sourceEncounterId: ENCOUNTER,
    sourceEncounterValid: true,
    supervisoryAt: T0,
    attestationMode: "aide_present",
    aidePerformanceSatisfactory: true,
    correctiveActions: null,
    cadenceDaysOverride: null,
  };

  it("the default cadence is the 42 CFR 418.76(h) 14-day floor", () => {
    expect(effectiveCadenceDays(null)).toBe(14);
    expect(computeNextSupervisoryDueAt(T0, null)).toBe("2026-03-15T15:00:00.000Z");
  });

  it("a tenant override may TIGHTEN but never loosen the floor (D3)", () => {
    expect(effectiveCadenceDays(7)).toBe(7);
    expect(computeNextSupervisoryDueAt(T0, 7)).toBe("2026-03-08T15:00:00.000Z");
    expectCode(() => effectiveCadenceDays(21), "SUPERVISORY_CADENCE_ILLEGAL");
    expectCode(() => effectiveCadenceDays(0), "SUPERVISORY_CADENCE_ILLEGAL");
  });

  it("§7.1 recording a supervision re-arms the clock and emits m15.aide_supervisory.completed", () => {
    const d = decideRecordSupervisoryVisit(FACTS);
    expect(d.advancesClock).toBe(true);
    expect(d.cadenceDaysAtInsert).toBe(14);
    expect(d.nextDueAt).toBe("2026-03-15T15:00:00.000Z");
    expect(d.effects.some((e) => e.kind === "recompute_supervisory_due")).toBe(true);
    expect(outboxEvents(d.effects)).toContain("m15.aide_supervisory.completed");
  });

  it("§2.2.4 a documented PHONE-only supervision is recorded but does NOT advance the clock", () => {
    const d = decideRecordSupervisoryVisit({
      ...FACTS,
      sourceEncounterId: null,
      sourceEncounterValid: false,
    });
    expect(d.advancesClock).toBe(false);
    expect(d.effects.some((e) => e.kind === "recompute_supervisory_due")).toBe(false);
    expect(outboxEvents(d.effects)).toContain("m15.aide_supervisory.completed");
  });

  it("§4.2 the guard set: plan not active / aide not on plan / not the supervisor / bad encounter", () => {
    expectCode(
      () => decideRecordSupervisoryVisit({ ...FACTS, planStatus: "draft" }),
      "PLAN_NOT_ACTIVE",
    );
    expectCode(
      () => decideRecordSupervisoryVisit({ ...FACTS, aideMembershipId: RN }),
      "AIDE_NOT_ON_PLAN",
    );
    expectCode(
      () => decideRecordSupervisoryVisit({ ...FACTS, supervisingRnMembershipId: AIDE }),
      "NOT_AIDE_SUPERVISOR",
    );
    expectCode(
      () => decideRecordSupervisoryVisit({ ...FACTS, sourceEncounterValid: false }),
      "INVALID_ENCOUNTER_REFERENCE",
    );
  });

  it("§4.2 unsatisfactory performance requires corrective actions of ≥40 chars", () => {
    expectCode(
      () =>
        decideRecordSupervisoryVisit({
          ...FACTS,
          aidePerformanceSatisfactory: false,
          correctiveActions: "retrain",
        }),
      "CORRECTIVE_ACTIONS_REQUIRED",
    );
    expect(() =>
      decideRecordSupervisoryVisit({
        ...FACTS,
        aidePerformanceSatisfactory: false,
        correctiveActions:
          "Re-trained on transfer technique and scheduled a follow-up observation within seven days.",
      }),
    ).not.toThrow();
  });

  it("§7.1 the ladder: on_time → due (day 12) → overdue (day 14) → gate_engaged (day 16)", () => {
    const facts = {
      planId: PLAN,
      nextSupervisoryDueAt: "2026-03-15T15:00:00.000Z",
      cadenceDaysOverride: null,
    };
    const at = (iso: string) => evaluateSupervisoryCadence(facts, iso)?.status;
    expect(at("2026-03-10T15:00:00.000Z")).toBe("on_time");
    expect(at("2026-03-13T15:00:00.000Z")).toBe("due");
    expect(at("2026-03-15T15:00:00.000Z")).toBe("overdue");
    expect(at("2026-03-17T15:00:00.000Z")).toBe("gate_engaged");
  });

  it("no armed clock (pre-first-signature) is no obligation, and the sign gate stays open", () => {
    const state = evaluateSupervisoryCadence(
      { planId: PLAN, nextSupervisoryDueAt: null, cadenceDaysOverride: null },
      T0,
    );
    expect(state).toBeNull();
    expect(isSupervisoryGateEngaged(state)).toBe(false);
  });

  it("the CHHA encounter-sign gate engages only at gate_engaged (§7.1 day 16)", () => {
    const facts = {
      planId: PLAN,
      nextSupervisoryDueAt: "2026-03-15T15:00:00.000Z",
      cadenceDaysOverride: null,
    };
    expect(
      isSupervisoryGateEngaged(evaluateSupervisoryCadence(facts, "2026-03-16T14:00:00.000Z")),
    ).toBe(false);
    expect(
      isSupervisoryGateEngaged(evaluateSupervisoryCadence(facts, "2026-03-18T15:00:00.000Z")),
    ).toBe(true);
  });

  it("hoursOverdue is 0 before the due instant and whole hours after it", () => {
    expect(hoursOverdue("2026-03-15T15:00:00.000Z", "2026-03-15T14:00:00.000Z")).toBe(0);
    expect(hoursOverdue("2026-03-15T15:00:00.000Z", "2026-03-16T15:30:00.000Z")).toBe(24);
  });
});

// ── §1.1 D10 / §7.2 / §7.3 initial clocks ───────────────────────────────────────────────────────────

describe("Initial-assessment clocks (§1.1 D10, §7.2, §7.3)", () => {
  it("§7.2 MSW: warn at day 3, overdue at day 5, satisfied by the signed initial assessment", () => {
    const base = {
      kind: "msw_plan" as const,
      clockStartedAt: T0,
      initialAssessmentSignedAt: null,
      spiritualCareDeclinedAt: null,
    };
    expect(evaluateInitialClock(base, "2026-03-02T15:00:00.000Z").warning).toBe(false);
    expect(evaluateInitialClock(base, "2026-03-04T15:00:00.000Z").warning).toBe(true);
    const breached = evaluateInitialClock(base, "2026-03-07T15:00:00.000Z");
    expect(breached.overdue).toBe(true);
    expect(breached.daysOverdue).toBe(1);
    expect(
      evaluateInitialClock(
        { ...base, initialAssessmentSignedAt: "2026-03-04T00:00:00.000Z" },
        "2026-03-07T15:00:00.000Z",
      ).overdue,
    ).toBe(false);
  });

  it("§7.3 spiritual: a recorded declination closes the clock with no escalation", () => {
    const declined = evaluateInitialClock(
      {
        kind: "spiritual_plan",
        clockStartedAt: T0,
        initialAssessmentSignedAt: null,
        spiritualCareDeclinedAt: "2026-03-02T09:00:00.000Z",
      },
      "2026-03-20T15:00:00.000Z",
    );
    expect(declined.satisfied).toBe(true);
    expect(declined.overdue).toBe(false);
  });

  it("§7.3 a declination does NOT satisfy the MSW clock (only the chaplain's is declinable)", () => {
    expect(
      evaluateInitialClock(
        {
          kind: "msw_plan",
          clockStartedAt: T0,
          initialAssessmentSignedAt: null,
          spiritualCareDeclinedAt: "2026-03-02T09:00:00.000Z",
        },
        "2026-03-20T15:00:00.000Z",
      ).overdue,
    ).toBe(true);
  });

  it("§1.1 the volunteer plan's 5 days are BUSINESS days", () => {
    // T0 = Sunday 2026-03-01 → five business days later is Friday 2026-03-06.
    const state = evaluateInitialClock(
      {
        kind: "volunteer_plan",
        clockStartedAt: T0,
        initialAssessmentSignedAt: null,
        spiritualCareDeclinedAt: null,
      },
      T0,
    );
    expect(state.dueAt).toBe("2026-03-06T15:00:00.000Z");
  });

  it("no anchor = no obligation (a lazily-bootstrapped plan raises no false survey flag)", () => {
    const state = evaluateInitialClock(
      {
        kind: "volunteer_plan",
        clockStartedAt: null,
        initialAssessmentSignedAt: null,
        spiritualCareDeclinedAt: null,
      },
      "2027-01-01T00:00:00.000Z",
    );
    expect(state.dueAt).toBeNull();
    expect(state.overdue).toBe(false);
  });
});

// ── §2.3 validation catalog ─────────────────────────────────────────────────────────────────────────

describe("Discipline-plan validation guards (§2.3)", () => {
  it("a patient-stated goal captures original_text verbatim and never mutates it", () => {
    expectCode(
      () =>
        checkGoalTextVerbatim({
          source: "patient_stated",
          originalText: "",
          isUpdate: false,
          mutatingOriginalText: false,
        }),
      "GOAL_TEXT_IMMUTABLE",
    );
    expectCode(
      () =>
        checkGoalTextVerbatim({
          source: "patient_stated",
          originalText: "I want to see my grandson graduate",
          isUpdate: true,
          mutatingOriginalText: true,
        }),
      "GOAL_TEXT_IMMUTABLE",
    );
    expect(() =>
      checkGoalTextVerbatim({
        source: "clinical",
        originalText: null,
        isUpdate: false,
        mutatingOriginalText: true,
      }),
    ).not.toThrow();
  });

  it("an agent-stated goal requires an ACTIVE dpoa_healthcare consent naming the agent", () => {
    expectCode(() => checkDpoaGoalConsent("agent_stated", false, "c-1"), "DPOA_CONSENT_REQUIRED");
    expectCode(() => checkDpoaGoalConsent("agent_stated", true, null), "DPOA_CONSENT_REQUIRED");
    expect(() => checkDpoaGoalConsent("agent_stated", true, "c-1")).not.toThrow();
    expect(() => checkDpoaGoalConsent("clinical", false, null)).not.toThrow();
  });

  it("§1.1 D1 the discipline boundary: an MSW may not author the Aide POC", () => {
    expectCode(() => checkAuthoringDiscipline("aide_poc", "msw"), "DISCIPLINE_SCOPE_VIOLATION");
    expect(() => checkAuthoringDiscipline("aide_poc", "rn")).not.toThrow();
    // The IDG-Coordinator / Clinical-Supervisor overrides are role-based and audited by the caller.
    expect(() => checkAuthoringDiscipline("aide_poc", "msw", true)).not.toThrow();
  });

  it("§7.3 a recorded spiritual-care declination is immutable", () => {
    expect(() => checkDeclinationImmutable(null)).not.toThrow();
    expectCode(
      () => checkDeclinationImmutable("2026-03-02T09:00:00.000Z"),
      "SPIRITUAL_DECLINATION_IMMUTABLE",
    );
  });

  it("§7.10 optimistic concurrency: a stale If-Match is 412", () => {
    expect(() => checkOptimisticConcurrency(3, 3)).not.toThrow();
    expectCode(() => checkOptimisticConcurrency(3, 4), "STALE_VERSION");
  });

  it("the volunteer out-of-scope acknowledgment must be complete", () => {
    expectCode(
      () => checkVolunteerOutOfScopeAcknowledged([]),
      "VOLUNTEER_OUT_OF_SCOPE_UNACKNOWLEDGED",
    );
    expect(() =>
      checkVolunteerOutOfScopeAcknowledged(READY.volunteerOutOfScopeAcknowledged),
    ).not.toThrow();
  });
});

// ── seam consumers: the REAL M7 / M8 seams via getSeam ──────────────────────────────────────────────

describe("M15-T03 — consuming M7's CarePlanReader (§2.1 / §2.3)", () => {
  afterEach(() => __resetSeamsForTest());

  const IPOC_PROBLEM = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const IPOC_GOAL = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

  function registerReader(): { calls: Array<{ type: string; discipline: string }> } {
    const calls: Array<{ type: string; discipline: string }> = [];
    registerSeam("CarePlanReader", {
      relevantElementsForEncounter: async (
        _patientId: string,
        encounterType: string,
        discipline: string,
      ) => {
        calls.push({ type: encounterType, discipline });
        return {
          planId: "plan-1",
          patientId: PATIENT,
          problems: [{ problemId: IPOC_PROBLEM }],
          goals: [{ goalId: IPOC_GOAL }],
          interventions: [],
          redacted: false,
        };
      },
      isReviewOverdue: async () => null,
    } as never);
    return { calls };
  }

  it("reads the IPOC through the plan kind's own discipline lens", async () => {
    const { calls } = registerReader();
    await assertParentElements(
      "msw_plan",
      PATIENT,
      { parentProblemId: IPOC_PROBLEM, parentGoalId: IPOC_GOAL },
      true,
    );
    expect(calls).toEqual([{ type: "msw_assessment", discipline: "msw" }]);
  });

  it("a discipline goal must reference an ACTIVE IPOC problem (§2.1 — no forked plan)", async () => {
    registerReader();
    await expectRejectCode(
      assertParentElements("msw_plan", PATIENT, { parentProblemId: null }, true),
      "PARENT_PROBLEM_REQUIRED",
    );
    await expectRejectCode(
      assertParentElements("msw_plan", PATIENT, { parentProblemId: "not-on-the-plan" }, true),
      "PARENT_ELEMENT_NOT_FOUND",
    );
  });

  it("optional parent links are legal as null but must resolve when supplied", async () => {
    registerReader();
    await expect(
      assertParentElements(
        "spiritual_plan",
        PATIENT,
        { parentProblemId: IPOC_PROBLEM, parentGoalId: null },
        true,
      ),
    ).resolves.toBeUndefined();
    await expectRejectCode(
      assertParentElements(
        "spiritual_plan",
        PATIENT,
        { parentProblemId: IPOC_PROBLEM, parentGoalId: "ghost" },
        true,
      ),
      "PARENT_ELEMENT_NOT_FOUND",
    );
  });

  it("fail-closed: a patient with no resolvable care plan can parent nothing", async () => {
    registerSeam("CarePlanReader", {
      relevantElementsForEncounter: async () => null,
      isReviewOverdue: async () => null,
    } as never);
    await expectRejectCode(
      assertParentElements("msw_plan", PATIENT, { parentProblemId: IPOC_PROBLEM }, true),
      "PARENT_ELEMENT_NOT_FOUND",
    );
  });
});

describe("M15-T03 — consuming M8's SignedEncountersReader (§2.2.4 / §2.3)", () => {
  afterEach(() => __resetSeamsForTest());

  function registerEncounters(digests: ReadonlyArray<Record<string, unknown>>): {
    since: string[];
  } {
    const since: string[] = [];
    registerSeam("SignedEncountersReader", {
      signedEncountersForPatientSince: async (_org: string, _pat: string, from: string) => {
        since.push(from);
        return digests;
      },
      renderPayloadFor: async () => ({ encounterId: ENCOUNTER, final: "", addenda: [] }),
    } as never);
    return { since };
  }

  it("§2.3 a supervisory reference must be the SUPERVISING RN's own signed encounter", async () => {
    registerEncounters([{ encounterId: ENCOUNTER, signedByMembershipId: RN, discipline: "rn" }]);
    await expect(
      isSupervisoryEncounterValid({
        orgId: ORG,
        patientId: PATIENT,
        encounterId: ENCOUNTER,
        supervisingRnMembershipId: RN,
        supervisoryAt: T0,
      }),
    ).resolves.toBe(true);
  });

  it("the aide's own visit can never evidence the supervision", async () => {
    registerEncounters([
      { encounterId: ENCOUNTER, signedByMembershipId: AIDE, discipline: "chha" },
    ]);
    await expect(
      isSupervisoryEncounterValid({
        orgId: ORG,
        patientId: PATIENT,
        encounterId: ENCOUNTER,
        supervisingRnMembershipId: RN,
        supervisoryAt: T0,
      }),
    ).resolves.toBe(false);
  });

  it("an encounter outside the patient's signed set is false (→ INVALID_ENCOUNTER_REFERENCE)", async () => {
    const { since } = registerEncounters([]);
    await expect(
      isAssessmentEncounterValid({
        orgId: ORG,
        patientId: PATIENT,
        encounterId: ENCOUNTER,
        capturedAt: T0,
      }),
    ).resolves.toBe(false);
    // The lookup windows back from the captured instant, never from "now".
    expect(since).toEqual(["2025-12-01T15:00:00.000Z"]);
  });

  it("a signed encounter on this patient validates an assessment reference", async () => {
    registerEncounters([{ encounterId: ENCOUNTER, signedByMembershipId: RN, discipline: "msw" }]);
    await expect(
      isAssessmentEncounterValid({
        orgId: ORG,
        patientId: PATIENT,
        encounterId: ENCOUNTER,
        capturedAt: T0,
      }),
    ).resolves.toBe(true);
  });
});
