// apps/backend/__tests__/oncall-lifecycle.test.ts — M19-T03 (§2.2 call machine, §2.3 validation, §2.2.4
// escalation ladder, D5 protocol engine, D6 disposition matrix, §2.7 BCP paper re-entry).
//
// The pure M19 on-call triage domain core — no DB, no seams, no clock: every fact is injected.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  TriageCallState,
  TriageDispositionData,
  TriageProtocolAnswerType,
} from "@wardenx/types";
import { TRIAGE_CALL_TERMINAL_STATES } from "@wardenx/types";
import { describe, expect, it } from "vitest";
import {
  type CallCloseEscalationVerdict,
  DISPOSITION_SCOPE_MATRIX,
  OUTAGE_GAP_FLOOR_MINUTES,
  type OutageWindow,
  SELECTABLE_DISPOSITIONS,
  TRIAGE_CALL_EDGES,
  type TriageActorDiscipline,
  type TriageAnswerFacts,
  type TriageCallFacts,
  type TriageEscalationFacts,
  type TriageProtocolFacts,
  type TriageProtocolQuestionFacts,
  acknowledgeEscalation,
  applyProtocol,
  assertAnswerInOrder,
  assertCallCloseable,
  assertDispositionInScope,
  assertDispositionPayload,
  assertPaperOriginCoherent,
  assertRecipientCoherent,
  assertWithinOutageWindow,
  autoResolveOnCallClose,
  availableCommands,
  buildPaperReentryWorklist,
  closeCall,
  completeProtocol,
  detectOutageWindows,
  disciplineSatisfies,
  dispositionEffects,
  escalateUnresolved,
  escalationState,
  evaluateRedFlag,
  linkPaperReentry,
  markAbandoned,
  markAwaitingCallback,
  markDocumented,
  nextUnansweredQuestion,
  permittedDispositions,
  recordAnswer,
  resolveEdge,
  resolveEscalation,
  resolveEscalationAndDisposition,
  resumeAfterCallback,
  selectDisposition,
  unansweredRequiredQuestions,
} from "../src/modules/19-oncall/lifecycle/index";

const ORG = "11111111-1111-1111-1111-111111111111";
const OTHER_ORG = "22222222-2222-2222-2222-222222222222";
const RN = "33333333-3333-3333-3333-333333333333";
const MD = "44444444-4444-4444-4444-444444444444";
const VENDOR = "55555555-5555-5555-5555-555555555555";
const PROTOCOL = "66666666-6666-6666-6666-666666666666";
const ENCOUNTER = "77777777-7777-7777-7777-777777777777";

const NOW = new Date("2026-07-31T02:00:00.000Z");

/**
 * Assert a guard raises the exact machine-readable code. `WardenXError.message` is prose for the on-call
 * clinician; the CODE is the contract the §5 panel and the §7 tables key off, so the tests assert on it —
 * `toThrowError(/CODE/)` passes only when the prose happens to contain the token (the M15-T03 finding).
 */
function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (err) {
    expect((err as { code?: string }).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}, but nothing was thrown`);
}

// ── fixtures ──────────────────────────────────────────────────────────────────────────────────────────

function protocolFacts(over: Partial<TriageProtocolFacts> = {}): TriageProtocolFacts {
  return {
    protocolId: PROTOCOL,
    key: "uncontrolled_pain",
    chiefComplaintLabel: "Uncontrolled pain",
    organizationId: null,
    isSystemLocked: true,
    disciplineRequired: "clinical_lpn",
    requiresMandatoryEscalation: false,
    mandatoryEscalationTier: null,
    version: "1.0",
    effectiveFrom: "2026-01-01T00:00:00.000Z",
    effectiveTo: null,
    ...over,
  };
}

function question(
  order: number,
  over: Partial<TriageProtocolQuestionFacts> = {},
): TriageProtocolQuestionFacts {
  return {
    questionId: `q-${order}`,
    protocolId: PROTOCOL,
    questionOrder: order,
    prompt: `question ${order}`,
    answerType: "boolean" as TriageProtocolAnswerType,
    answerEnumValues: null,
    required: true,
    isRedFlagQuestion: false,
    redFlagMatch: null,
    ...over,
  };
}

function answer(questionId: string, over: Partial<TriageAnswerFacts> = {}): TriageAnswerFacts {
  return {
    answerId: `a-${questionId}`,
    questionId,
    correctionOfAnswerId: null,
    redFlagHit: false,
    ...over,
  };
}

function call(over: Partial<TriageCallFacts> = {}): TriageCallFacts {
  return {
    state: "open",
    version: 1,
    selectedProtocolId: null,
    linkedEncounterId: null,
    firstResponseAt: null,
    documentedAt: null,
    paperOriginFlag: false,
    ...over,
  };
}

function escalation(over: Partial<TriageEscalationFacts> = {}): TriageEscalationFacts {
  return {
    escalationId: "esc-1",
    tier: "tier_1_rn_supervisor",
    triggerKind: "manual",
    escalatedAt: "2026-07-31T02:05:00.000Z",
    acknowledgedAt: null,
    resolvedAt: null,
    escalatedToMembershipId: RN,
    escalatedToExternalActorId: null,
    ...over,
  };
}

const EDUCATION: TriageDispositionData = {
  disposition: "caregiver_education_only",
  educationSummary: "Repositioned; PRN morphine given at 02:10; call back if no relief in 45 min.",
  followUpCallAt: null,
};

// ── §2.2.1 the call machine ───────────────────────────────────────────────────────────────────────────

describe("§2.2.1 — the triage-call transition table is a WHITELIST, not a rank order", () => {
  it("admits the two edges that run BACKWARDS", () => {
    // A machine implemented as "the target must rank above the source" silently forbids the second of
    // these, stranding every escalated call forever (the M19-T02 finding, at the application layer).
    expect(resolveEdge("awaiting_callback", "resumeAfterCallback").to).toBe("protocol_in_progress");
    expect(resolveEdge("escalated_unresolved", "resolveEscalation").to).toBe(
      "documented_pending_encounter",
    );
  });

  it("refuses a command that has no edge from this state", () => {
    expectCode(() => resolveEdge("open", "selectDisposition"), "INVALID_STATE_TRANSITION");
    expectCode(
      () => resolveEdge("disposition_pending", "applyProtocol"),
      "INVALID_STATE_TRANSITION",
    );
  });

  it("refuses every command from a terminal state", () => {
    for (const terminal of TRIAGE_CALL_TERMINAL_STATES) {
      expectCode(() => resolveEdge(terminal, "closeCall"), "TRIAGE_CALL_TERMINAL");
      expect(availableCommands(terminal)).toEqual([]);
    }
  });

  it("has no (from, command) pair with two targets", () => {
    // `resolveEdge` is a `.find()`: a duplicate key would silently pick the first (the M21-T03 finding).
    const keys = TRIAGE_CALL_EDGES.map((e) => `${e.from}|${e.command}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("is a SUBSET of migration 0108's forward-transition trigger whitelist", () => {
    // The DB trigger is the coarse net; this table is the policy. Every app edge must be one the database
    // would accept — an edge the trigger rejects is a 500 at 2 a.m. The converse is deliberately NOT
    // asserted: 0108 admits `documented_pending_encounter → abandoned` and this table does not, because
    // once a disposition is selected and the M8 encounter created, "the caller hung up" is no longer an
    // outcome — the clinical decision is already on the record and the §2.7 D-B park must not be
    // abandonable while the encounter-creator worker is still retrying.
    const sql = readFileSync(
      join(
        import.meta.dirname,
        "..",
        "..",
        "..",
        "packages",
        "db",
        "migrations",
        "0108_oncall_m19_rls_audit_triggers.sql",
      ),
      "utf8",
    );
    const allowed = new Map<string, readonly string[]>();
    for (const m of sql.matchAll(/WHEN '(\w+)' THEN ARRAY\[([^\]]*)\]/g)) {
      allowed.set(
        m[1] as string,
        [...(m[2] as string).matchAll(/'(\w+)'/g)].map((x) => x[1] as string),
      );
    }
    expect(allowed.size).toBeGreaterThan(0);
    for (const edge of TRIAGE_CALL_EDGES) {
      expect(allowed.get(edge.from) ?? []).toContain(edge.to);
    }
  });
});

// ── D4 / §7.3 apply-protocol ──────────────────────────────────────────────────────────────────────────

describe("D4 / §7.3 — applyProtocol pins a version and gates on scope", () => {
  it("pins the protocol version and emits protocol_applied", () => {
    const { decision, effects } = applyProtocol({
      orgId: ORG,
      protocol: protocolFacts({ version: "2.1" }),
      actorDiscipline: "clinical_rn",
      at: NOW,
      suggestedProtocolId: null,
    });
    expect(decision.pinnedVersion).toBe("2.1");
    expect(decision.mandatoryTier).toBeNull();
    expect(decision.aiAccepted).toBeNull();
    expect(effects).toContainEqual({ kind: "audit" });
    expect(effects).toContainEqual({
      kind: "state_history",
      from: "open",
      to: "protocol_in_progress",
      systemActor: false,
    });
    expect(effects).toContainEqual({
      kind: "pin_protocol",
      protocolId: PROTOCOL,
      version: "2.1",
      aiAccepted: null,
    });
  });

  it("D12 — records whether the clinician took or overrode the M32 suggestion", () => {
    const accepted = applyProtocol({
      orgId: ORG,
      protocol: protocolFacts(),
      actorDiscipline: "clinical_rn",
      at: NOW,
      suggestedProtocolId: PROTOCOL,
    });
    expect(accepted.decision.aiAccepted).toBe(true);

    // §7.8 — the clinician judged the suggestion wrong and chose another protocol.
    const overridden = applyProtocol({
      orgId: ORG,
      protocol: protocolFacts(),
      actorDiscipline: "clinical_rn",
      at: NOW,
      suggestedProtocolId: "some-other-protocol",
    });
    expect(overridden.decision.aiAccepted).toBe(false);
  });

  it("refuses a protocol belonging to another tenant, and a retired one", () => {
    expectCode(
      () =>
        applyProtocol({
          orgId: ORG,
          protocol: protocolFacts({ organizationId: OTHER_ORG, isSystemLocked: false }),
          actorDiscipline: "clinical_rn",
          at: NOW,
          suggestedProtocolId: null,
        }),
      "PROTOCOL_NOT_AVAILABLE",
    );
    expectCode(
      () =>
        applyProtocol({
          orgId: ORG,
          protocol: protocolFacts({ effectiveTo: "2026-06-01T00:00:00.000Z" }),
          actorDiscipline: "clinical_rn",
          at: NOW,
          suggestedProtocolId: null,
        }),
      "PROTOCOL_NOT_EFFECTIVE",
    );
  });

  it("§7.3 — refuses an actor below the protocol's discipline floor", () => {
    expectCode(
      () =>
        applyProtocol({
          orgId: ORG,
          protocol: protocolFacts({ disciplineRequired: "clinical_rn" }),
          actorDiscipline: "clinical_lpn",
          at: NOW,
          suggestedProtocolId: null,
        }),
      "PROTOCOL_OUT_OF_DISCIPLINE_SCOPE",
    );
  });

  it("§7.3 — the ladder ranks, and OFF-ladder disciplines match exactly", () => {
    expect(disciplineSatisfies("clinical_rn", "clinical_lpn")).toBe(true);
    expect(disciplineSatisfies("clinical_lpn", "clinical_rn")).toBe(false);
    expect(disciplineSatisfies("supervisor", "clinical_rn")).toBe(true);
    // An RN takes the psychosocial-crisis call at 2 a.m. — the §7.9 / §1.1 ordinary case.
    expect(disciplineSatisfies("clinical_rn", "msw")).toBe(true);
    // …but an MSW is not "above" an LPN on a cardiac protocol.
    expect(disciplineSatisfies("msw", "clinical_lpn")).toBe(false);
    expect(disciplineSatisfies("msw", "msw")).toBe(true);
    expect(disciplineSatisfies("external", "clinical_rn")).toBe(false);
  });

  it("D7 / §7.2 — a mandatory-escalation protocol writes the escalation in the SAME effect list", () => {
    const { decision, effects } = applyProtocol({
      orgId: ORG,
      protocol: protocolFacts({
        key: "suicidal_ideation",
        disciplineRequired: "clinical_rn",
        requiresMandatoryEscalation: true,
        mandatoryEscalationTier: "tier_3_medical_director",
      }),
      actorDiscipline: "clinical_rn",
      at: NOW,
      suggestedProtocolId: null,
    });
    expect(decision.mandatoryTier).toBe("tier_3_medical_director");
    expect(effects).toContainEqual({
      kind: "create_escalation",
      tier: "tier_3_medical_director",
      triggerKind: "mandatory_protocol",
      mandatory: true,
      // §7.2 / the wave plan: the medical director AND the on-call supervisor whose shift it is.
      notifyTiers: ["tier_1_rn_supervisor", "tier_3_medical_director"],
    });
    expect(effects).toContainEqual({
      kind: "alert",
      alert: "m19.triage.mandatory_escalation_triggered",
    });
  });

  it("D7 — refuses a mandatory protocol that names no tier rather than treating it as 'no escalation'", () => {
    expectCode(
      () =>
        applyProtocol({
          orgId: ORG,
          protocol: protocolFacts({
            requiresMandatoryEscalation: true,
            mandatoryEscalationTier: null,
          }),
          actorDiscipline: "clinical_rn",
          at: NOW,
          suggestedProtocolId: null,
        }),
      "PROTOCOL_MANDATORY_TIER_MISSING",
    );
  });
});

// ── D5 the ordered walk + the red-flag evaluator ──────────────────────────────────────────────────────

describe("D5 / §7.1 — the walk is server-authoritative", () => {
  const questions = [question(1), question(2), question(3)];

  it("tracks its own cursor", () => {
    expect(nextUnansweredQuestion(questions, [])?.questionOrder).toBe(1);
    expect(nextUnansweredQuestion(questions, [answer("q-1")])?.questionOrder).toBe(2);
    expect(
      nextUnansweredQuestion(
        questions,
        questions.map((q) => answer(q.questionId)),
      ),
    ).toBeNull();
  });

  it("refuses a POST for a question the walk has not reached", () => {
    expectCode(
      () =>
        assertAnswerInOrder({
          question: question(3),
          questions,
          answers: [],
          protocolId: PROTOCOL,
          isCorrection: false,
        }),
      "PROTOCOL_QUESTION_OUT_OF_ORDER",
    );
  });

  it("refuses a second ORIGINAL answer, and a question from another protocol", () => {
    expectCode(
      () =>
        assertAnswerInOrder({
          question: question(1),
          questions,
          answers: [answer("q-1")],
          protocolId: PROTOCOL,
          isCorrection: false,
        }),
      "PROTOCOL_QUESTION_ALREADY_ANSWERED",
    );
    expectCode(
      () =>
        assertAnswerInOrder({
          question: question(1, { protocolId: "other" }),
          questions,
          answers: [],
          protocolId: PROTOCOL,
          isCorrection: false,
        }),
      "PROTOCOL_QUESTION_NOT_IN_PROTOCOL",
    );
  });

  it("§2.2.3 — a CORRECTION is exempt from the order gate", () => {
    // Amend question 1 after answering 1–3: forbidding it would push the clinician to abandon the call.
    const answers = questions.map((q) => answer(q.questionId));
    const out = recordAnswer({
      question: question(1),
      questions,
      answers,
      protocolId: PROTOCOL,
      value: { kind: "bool", value: true },
      correctionOfAnswerId: "a-q-1",
      answeredByMembershipId: RN,
    });
    expect(out.effects).toContainEqual({
      kind: "record_answer",
      questionId: "q-1",
      redFlagHit: false,
      isCorrection: true,
    });
  });

  it("§2.2.3 — a correction chains to the ORIGINAL, never to another correction", () => {
    const answers = [
      answer("q-1"),
      answer("q-1", { answerId: "a-fix", correctionOfAnswerId: "a-q-1" }),
    ];
    expectCode(
      () =>
        recordAnswer({
          question: question(1),
          questions,
          answers,
          protocolId: PROTOCOL,
          value: { kind: "bool", value: false },
          correctionOfAnswerId: "a-fix",
          answeredByMembershipId: RN,
        }),
      "CORRECTION_OF_CORRECTION_FORBIDDEN",
    );
  });

  it("refuses an answer written to the wrong typed column, or a blank one", () => {
    expectCode(
      () =>
        recordAnswer({
          question: question(1, { answerType: "scale_0_10" }),
          questions: [question(1, { answerType: "scale_0_10" })],
          answers: [],
          protocolId: PROTOCOL,
          value: { kind: "bool", value: true },
          correctionOfAnswerId: null,
          answeredByMembershipId: RN,
        }),
      "ANSWER_VALUE_TYPE_MISMATCH",
    );
    expectCode(
      () =>
        recordAnswer({
          question: question(1, { answerType: "free_text" }),
          questions: [question(1, { answerType: "free_text" })],
          answers: [],
          protocolId: PROTOCOL,
          value: { kind: "text", value: "   " },
          correctionOfAnswerId: null,
          answeredByMembershipId: RN,
        }),
      "ANSWER_VALUE_REQUIRED",
    );
  });

  it("refuses an enum answer outside the question's own value list, and an out-of-range scale", () => {
    const enumQ = question(1, {
      answerType: "enum",
      answerEnumValues: ["refill", "side_effect"],
    });
    expectCode(
      () =>
        recordAnswer({
          question: enumQ,
          questions: [enumQ],
          answers: [],
          protocolId: PROTOCOL,
          value: { kind: "text", value: "something_else" },
          correctionOfAnswerId: null,
          answeredByMembershipId: RN,
        }),
      "ANSWER_VALUE_TYPE_MISMATCH",
    );
    const scaleQ = question(1, { answerType: "scale_0_10" });
    expectCode(
      () =>
        recordAnswer({
          question: scaleQ,
          questions: [scaleQ],
          answers: [],
          protocolId: PROTOCOL,
          value: { kind: "int", value: 11 },
          correctionOfAnswerId: null,
          answeredByMembershipId: RN,
        }),
      "ANSWER_VALUE_TYPE_MISMATCH",
    );
  });

  it("evaluates every red-flag arm against the column it names", () => {
    const q = (
      match: TriageProtocolQuestionFacts["redFlagMatch"],
      type: TriageProtocolAnswerType,
    ) => question(1, { isRedFlagQuestion: true, redFlagMatch: match, answerType: type });

    expect(
      evaluateRedFlag(q({ kind: "bool_is", value: true }, "boolean"), {
        kind: "bool",
        value: true,
      }),
    ).toBe(true);
    expect(
      evaluateRedFlag(q({ kind: "bool_is", value: true }, "boolean"), {
        kind: "bool",
        value: false,
      }),
    ).toBe(false);
    expect(
      evaluateRedFlag(q({ kind: "int_at_least", threshold: 7 }, "scale_0_10"), {
        kind: "int",
        value: 7,
      }),
    ).toBe(true);
    expect(
      evaluateRedFlag(q({ kind: "int_at_most", threshold: 60 }, "integer"), {
        kind: "int",
        value: 45,
      }),
    ).toBe(true);
    expect(
      evaluateRedFlag(q({ kind: "enum_in", values: ["refill"] }, "enum"), {
        kind: "text",
        value: "refill",
      }),
    ).toBe(true);
    expect(
      evaluateRedFlag(q({ kind: "text_any" }, "free_text"), { kind: "text", value: "x" }),
    ).toBe(true);
    // A question that is not a red-flag question never fires, whatever its predicate says.
    expect(
      evaluateRedFlag(question(1, { redFlagMatch: { kind: "bool_is", value: true } }), {
        kind: "bool",
        value: true,
      }),
    ).toBe(false);
  });

  it("D5 — a red-flag hit creates the escalation in the SAME effect list as the answer", () => {
    const flagQ = question(1, {
      isRedFlagQuestion: true,
      redFlagMatch: { kind: "bool_is", value: true },
    });
    const out = recordAnswer({
      question: flagQ,
      questions: [flagQ],
      answers: [],
      protocolId: PROTOCOL,
      value: { kind: "bool", value: true },
      correctionOfAnswerId: null,
      answeredByMembershipId: RN,
    });
    expect(out.redFlagHit).toBe(true);
    expect(out.effects).toContainEqual({
      kind: "create_escalation",
      tier: "tier_1_rn_supervisor",
      triggerKind: "red_flag_question",
      mandatory: false,
      notifyTiers: ["tier_1_rn_supervisor"],
    });
    expect(out.effects).toContainEqual({ kind: "outbox", event: "m19.triage_call.red_flag_hit" });
  });
});

// ── §2.3 completeProtocol's two gates ────────────────────────────────────────────────────────────────

describe("§2.3 — completeProtocol", () => {
  const questions = [question(1), question(2, { required: false }), question(3)];
  const inProgress = call({ state: "protocol_in_progress", selectedProtocolId: PROTOCOL });

  it("advances when every REQUIRED question has an original answer", () => {
    const t = completeProtocol({
      call: inProgress,
      questions,
      answers: [answer("q-1"), answer("q-3")],
      escalations: [],
    });
    expect(t.to).toBe("disposition_pending");
  });

  it("refuses while a required question is unanswered, and names the first gap", () => {
    expect(
      unansweredRequiredQuestions(questions, [answer("q-1")]).map((q) => q.questionOrder),
    ).toEqual([3]);
    expectCode(
      () =>
        completeProtocol({
          call: inProgress,
          questions,
          answers: [answer("q-1")],
          escalations: [],
        }),
      "REQUIRED_QUESTIONS_UNANSWERED",
    );
  });

  it("refuses while a red-flag escalation is still unacknowledged", () => {
    expectCode(
      () =>
        completeProtocol({
          call: inProgress,
          questions,
          answers: [answer("q-1"), answer("q-3")],
          escalations: [escalation({ triggerKind: "red_flag_question" })],
        }),
      "RED_FLAG_ESCALATION_UNRESOLVED",
    );
  });

  it("a CORRECTION row does not satisfy a required question on its own", () => {
    // Only original answers count — otherwise a correction of q-1 would appear to answer q-3.
    expectCode(
      () =>
        completeProtocol({
          call: inProgress,
          questions,
          answers: [answer("q-1"), answer("q-3", { correctionOfAnswerId: "a-q-1" })],
          escalations: [],
        }),
      "REQUIRED_QUESTIONS_UNANSWERED",
    );
  });
});

// ── §2.2.4 / D7 the escalation ladder ────────────────────────────────────────────────────────────────

describe("§2.2.4 / D7 — the escalation ladder", () => {
  it("derives its state from the two timestamps", () => {
    expect(escalationState(escalation())).toBe("open");
    expect(escalationState(escalation({ acknowledgedAt: "2026-07-31T02:10:00.000Z" }))).toBe(
      "acknowledged",
    );
    expect(
      escalationState(
        escalation({
          acknowledgedAt: "2026-07-31T02:10:00.000Z",
          resolvedAt: "2026-07-31T02:30:00.000Z",
        }),
      ),
    ).toBe("resolved");
  });

  it("acknowledges once, and refuses to resolve before acknowledging", () => {
    const acked = acknowledgeEscalation({
      escalation: escalation(),
      by: MD,
      at: "2026-07-31T02:10:00.000Z",
    });
    expect(acked.to).toBe("acknowledged");
    expect(acked.effects).toContainEqual({
      kind: "set_timestamp",
      field: "acknowledged_at",
      at: "2026-07-31T02:10:00.000Z",
    });
    expectCode(
      () =>
        acknowledgeEscalation({
          escalation: escalation({ acknowledgedAt: "2026-07-31T02:10:00.000Z" }),
          by: MD,
          at: "2026-07-31T02:20:00.000Z",
        }),
      "ESCALATION_ALREADY_ACKNOWLEDGED",
    );
    expectCode(
      () =>
        resolveEscalation({
          escalation: escalation(),
          resolution: "advised GIP admission",
          by: MD,
          at: "2026-07-31T02:30:00.000Z",
        }),
      "ESCALATION_INVALID_TRANSITION",
    );
  });

  it("requires a resolution that says something", () => {
    expectCode(
      () =>
        resolveEscalation({
          escalation: escalation({ acknowledgedAt: "2026-07-31T02:10:00.000Z" }),
          resolution: "  ",
          by: MD,
          at: "2026-07-31T02:30:00.000Z",
        }),
      "ESCALATION_RESOLUTION_REQUIRED",
    );
  });

  it("§3.3 — exactly one recipient kind, decided by the tier", () => {
    expectCode(
      () =>
        assertRecipientCoherent({
          tier: "tier_3_medical_director",
          escalatedToMembershipId: null,
          escalatedToExternalActorId: VENDOR,
        }),
      "ESCALATION_RECIPIENT_REQUIRED",
    );
    expectCode(
      () =>
        assertRecipientCoherent({
          tier: "tier_5_external",
          escalatedToMembershipId: RN,
          escalatedToExternalActorId: null,
        }),
      "ESCALATION_RECIPIENT_REQUIRED",
    );
    expect(() =>
      assertRecipientCoherent({
        tier: "tier_5_external",
        escalatedToMembershipId: null,
        escalatedToExternalActorId: VENDOR,
      }),
    ).not.toThrow();
  });

  it("a call close NEVER auto-resolves a mandatory escalation", () => {
    const mandatory = escalation({
      triggerKind: "mandatory_protocol",
      tier: "tier_3_medical_director",
      escalatedToMembershipId: MD,
      // Even ACKNOWLEDGED, it needs the escalated party's explicit resolution (§2.2.4).
      acknowledgedAt: "2026-07-31T02:10:00.000Z",
    });
    const verdict: CallCloseEscalationVerdict = autoResolveOnCallClose(
      [mandatory],
      "2026-07-31T03:00:00.000Z",
    );
    expect(verdict.outcomes[0]).toEqual({
      escalationId: "esc-1",
      resolved: false,
      blockedReason: "mandatory",
    });
    expectCode(
      () => assertCallCloseable([mandatory]),
      "MANDATORY_ESCALATION_AUTO_RESOLVE_FORBIDDEN",
    );
  });

  it("auto-resolves an ACKNOWLEDGED non-mandatory row with no fabricated actor", () => {
    const verdict = autoResolveOnCallClose(
      [escalation({ acknowledgedAt: "2026-07-31T02:10:00.000Z" })],
      "2026-07-31T03:00:00.000Z",
    );
    expect(verdict.outcomes[0]?.resolved).toBe(true);
    // §3.3 has no `resolved_at ⇒ resolved_by_membership_id` companion precisely so this system write does
    // not have to invent a membership; attribution lives in the M4 audit row's actor_kind.
    expect(verdict.effects).toContainEqual({ kind: "resolve_escalation", by: null });
  });

  it("cannot auto-resolve an UNACKNOWLEDGED row — the §3.3 CHECK forbids resolving without an ack", () => {
    const verdict = autoResolveOnCallClose([escalation()], "2026-07-31T03:00:00.000Z");
    expect(verdict.outcomes[0]).toEqual({
      escalationId: "esc-1",
      resolved: false,
      blockedReason: "unacknowledged",
    });
  });
});

// ── D6 / §7.3 the disposition matrix ─────────────────────────────────────────────────────────────────

describe("D6 / §6 / §7.3 — the role × disposition scope matrix", () => {
  it("§7.3 — an LPN may select only the two advisory dispositions", () => {
    expect(permittedDispositions("clinical_lpn")).toEqual([
      "caregiver_education_only",
      "prn_intervention_authorized",
    ]);
    expectCode(
      () => assertDispositionInScope("clinical_lpn", "visit_dispatched_now"),
      "DISPOSITION_OUT_OF_SCOPE",
    );
    expect(() =>
      assertDispositionInScope("clinical_lpn", "caregiver_education_only"),
    ).not.toThrow();
  });

  it("an RN-or-above may select all eight", () => {
    for (const d of SELECTABLE_DISPOSITIONS) {
      expect(() => assertDispositionInScope("clinical_rn", d)).not.toThrow();
      expect(() => assertDispositionInScope("supervisor", d)).not.toThrow();
    }
  });

  it("§7.5 / D13 — a vendor operator may not propose GIP, take a verbal order, or schedule a pronouncement", () => {
    for (const denied of [
      "gip_admission_proposed",
      "verbal_order_recorded",
      "pronouncement_scheduled",
    ] as const) {
      expectCode(() => assertDispositionInScope("external", denied), "DISPOSITION_OUT_OF_SCOPE");
    }
    expect(() => assertDispositionInScope("external", "visit_dispatched_now")).not.toThrow();
  });

  it("every scope's option list is a subset of the eight selectable dispositions", () => {
    for (const options of Object.values(DISPOSITION_SCOPE_MATRIX)) {
      for (const option of options) {
        expect(SELECTABLE_DISPOSITIONS).toContain(option);
      }
    }
  });

  it("the two dual-purpose enum members are NOT selectable through the disposition route", () => {
    // Each is reached by its own command, which carries a permission the disposition route does not.
    for (const discipline of ["clinical_rn", "supervisor"] as TriageActorDiscipline[]) {
      expectCode(
        () => assertDispositionInScope(discipline, "escalated_unresolved"),
        "DISPOSITION_NOT_SELECTABLE",
      );
      expectCode(
        () => assertDispositionInScope(discipline, "abandoned"),
        "DISPOSITION_NOT_SELECTABLE",
      );
    }
  });

  it("refuses a payload whose discriminant disagrees with the selected disposition", () => {
    expectCode(
      () => assertDispositionPayload("visit_dispatched_now", EDUCATION),
      "DISPOSITION_PAYLOAD_INVALID",
    );
  });

  it("D15 — a PRN authorization must name the existing order it authorizes", () => {
    expectCode(
      () =>
        assertDispositionPayload("prn_intervention_authorized", {
          disposition: "prn_intervention_authorized",
          orderRecordId: null,
          medicationOrderId: null,
          instructionsGiven: "give 5mg PRN",
        }),
      "DISPOSITION_PAYLOAD_INVALID",
    );
  });

  it("CMS 418.52 — an ED transfer must carry the family's election text", () => {
    expectCode(
      () =>
        assertDispositionPayload("ed_transfer_acknowledged", {
          disposition: "ed_transfer_acknowledged",
          electionText: "",
          transportArrangedBy: "family",
        }),
      "DISPOSITION_PAYLOAD_INVALID",
    );
  });

  it("§7.9 — a pronouncement ALSO asks M17 for the dispatch visit", () => {
    expect(dispositionEffects("pronouncement_scheduled")).toContainEqual({
      kind: "outbox",
      event: "m19.triage_call.visit_needed",
    });
  });

  it("every disposition invokes the M8 EncounterCreator seam (D8)", () => {
    for (const d of SELECTABLE_DISPOSITIONS) {
      expect(dispositionEffects(d)).toContainEqual({ kind: "create_encounter" });
      expect(dispositionEffects(d)).toContainEqual({
        kind: "outbox",
        event: "m19.triage_call.disposition_selected",
      });
    }
  });
});

// ── §7.2 the mandatory-escalation disposition gate ───────────────────────────────────────────────────

describe("§7.2 — a suicidal-ideation call cannot be dispositioned around", () => {
  const pending = call({ state: "disposition_pending", selectedProtocolId: PROTOCOL });
  const openMandatory = escalation({
    triggerKind: "mandatory_protocol",
    tier: "tier_3_medical_director",
    escalatedToMembershipId: MD,
  });

  it("blocks every disposition while the mandatory escalation is unacknowledged", () => {
    expectCode(
      () =>
        selectDisposition({
          call: pending,
          escalations: [openMandatory],
          actorDiscipline: "clinical_rn",
          disposition: "caregiver_education_only",
          data: EDUCATION,
          at: NOW.toISOString(),
        }),
      "DISPOSITION_BLOCKED_BY_MANDATORY_ESCALATION",
    );
  });

  it("leaves escalateUnresolved as the only outcome, and the call stays OPEN", () => {
    const t = escalateUnresolved({
      call: pending,
      tier: "tier_3_medical_director",
      escalatedToMembershipId: MD,
      escalatedToExternalActorId: null,
      reason: "MD guidance required before any disposition",
    });
    expect(t.to).toBe("escalated_unresolved");
    expect(t.effects).toContainEqual({
      kind: "outbox",
      event: "m19.triage_call.escalation_recorded",
    });
  });

  it("unblocks once the medical director acknowledges, then the RN dispositions with their guidance", () => {
    const acked = { ...openMandatory, acknowledgedAt: "2026-07-31T02:20:00.000Z" };
    const t = resolveEscalationAndDisposition({
      call: call({ state: "escalated_unresolved", selectedProtocolId: PROTOCOL }),
      escalations: [acked],
      actorDiscipline: "clinical_rn",
      disposition: "gip_admission_proposed",
      data: {
        disposition: "gip_admission_proposed",
        gipCriteriaSummary: "Uncontrolled symptoms requiring inpatient management",
        preferredFacility: null,
      },
    });
    expect(t.to).toBe("documented_pending_encounter");
    expect(t.effects).toContainEqual({
      kind: "outbox",
      event: "m19.triage_call.gip_admission_proposed",
    });
  });

  it("§2.2.4 — abandoning the call does not clear a mandatory escalation either", () => {
    // The cheapest suppression path in the module, closed: "the caller hung up" is not an answer to
    // "did a human respond to the suicidal-ideation page?".
    expectCode(
      () =>
        markAbandoned({
          call: pending,
          escalations: [openMandatory],
          reason: "caller disconnected",
          callbackAttempts: 2,
          at: NOW.toISOString(),
        }),
      "MANDATORY_ESCALATION_AUTO_RESOLVE_FORBIDDEN",
    );
  });
});

// ── M19-F06 / ADR-0022 the documentation tail ────────────────────────────────────────────────────────

describe("M19-F06 / D8 — disposition parks the call; m8.encounter.signed advances it", () => {
  it("selectDisposition reaches documented_pending_encounter, NOT documented", () => {
    const t = selectDisposition({
      call: call({ state: "disposition_pending", selectedProtocolId: PROTOCOL }),
      escalations: [],
      actorDiscipline: "clinical_rn",
      disposition: "visit_dispatched_now",
      data: {
        disposition: "visit_dispatched_now",
        requestedDiscipline: "rn",
        requestedArrivalBy: "2026-07-31T04:00:00.000Z",
        reason: "Acute pain; needs in-person assessment",
      },
      at: NOW.toISOString(),
    });
    expect(t.to).toBe("documented_pending_encounter");
    expect(t.effects).toContainEqual({ kind: "outbox", event: "m19.triage_call.visit_needed" });
    expect(t.effects).toContainEqual({ kind: "create_encounter" });
  });

  it("refuses an encounter-signed event for a DIFFERENT encounter", () => {
    expectCode(
      () =>
        markDocumented({
          call: call({
            state: "documented_pending_encounter",
            linkedEncounterId: ENCOUNTER,
          }),
          signedEncounterId: "some-other-encounter",
          at: NOW.toISOString(),
        }),
      "ENCOUNTER_LINK_MISMATCH",
    );
  });

  it("§2.7 D-B — a call with no linked encounter stays parked rather than advancing", () => {
    expectCode(
      () =>
        markDocumented({
          call: call({ state: "documented_pending_encounter" }),
          signedEncounterId: ENCOUNTER,
          at: NOW.toISOString(),
        }),
      "ENCOUNTER_NOT_LINKED",
    );
  });

  it("marks documented as a SYSTEM transition", () => {
    const t = markDocumented({
      call: call({ state: "documented_pending_encounter", linkedEncounterId: ENCOUNTER }),
      signedEncounterId: ENCOUNTER,
      at: "2026-07-31T03:00:00.000Z",
    });
    expect(t.to).toBe("documented");
    expect(t.effects).toContainEqual({
      kind: "state_history",
      from: "documented_pending_encounter",
      to: "documented",
      systemActor: true,
    });
  });

  it("§2.2.1 — the close worker waits out the 30-minute amendment grace", () => {
    const documented = call({ state: "documented", documentedAt: "2026-07-31T03:00:00.000Z" });
    expectCode(
      () => closeCall({ call: documented, escalations: [], at: "2026-07-31T03:20:00.000Z" }),
      "DOCUMENTED_CLOSE_GRACE_NOT_ELAPSED",
    );
    const t = closeCall({ call: documented, escalations: [], at: "2026-07-31T03:31:00.000Z" });
    expect(t.to).toBe("closed");
    expect(t.effects).toContainEqual({ kind: "outbox", event: "m19.triage_call.closed" });
  });
});

describe("§2.2.1 — callback and abandon", () => {
  it("waives the required-questions check and starts the SLA timer", () => {
    const t = markAwaitingCallback({
      call: call({ state: "protocol_in_progress" }),
      reason: "caller did not answer the callback number",
    });
    expect(t.to).toBe("awaiting_callback");
    expect(resumeAfterCallback(call({ state: "awaiting_callback" })).to).toBe(
      "protocol_in_progress",
    );
  });

  it("requires a reason on both", () => {
    expectCode(
      () => markAwaitingCallback({ call: call({ state: "protocol_in_progress" }), reason: " " }),
      "CALLBACK_REASON_REQUIRED",
    );
    expectCode(
      () =>
        markAbandoned({
          call: call(),
          escalations: [],
          reason: "",
          callbackAttempts: 1,
          at: NOW.toISOString(),
        }),
      "ABANDON_REASON_REQUIRED",
    );
  });

  it("records the abandon disposition and closes the row out", () => {
    const t = markAbandoned({
      call: call({ state: "protocol_in_progress" }),
      escalations: [],
      reason: "caller hung up after reporting the patient had settled",
      callbackAttempts: 2,
      at: NOW.toISOString(),
    });
    expect(t.to).toBe("abandoned" satisfies TriageCallState);
    expect(t.effects).toContainEqual({
      kind: "set_disposition",
      disposition: "abandoned",
      data: {
        disposition: "abandoned",
        reason: "caller hung up after reporting the patient had settled",
        callbackAttempts: 2,
      },
    });
  });
});

// ── §2.7 / M19-F08 the BCP paper-re-entry path ───────────────────────────────────────────────────────

describe("§2.7 / M19-F08 — BCP paper re-entry", () => {
  const t = (h: number, m = 0) => new Date(Date.UTC(2026, 6, 30, h, m, 0)).toISOString();

  it("finds the outage by the gap where nothing was written", () => {
    // 13:00 → 23:30 is 10.5 h with nothing written: the platform was down through the covered evening.
    const windows = detectOutageWindows([t(12), t(13), t(23, 30)], t(23, 45));
    expect(windows).toHaveLength(1);
    expect(windows[0]?.startsAt).toBe(t(13));
    expect(windows[0]?.endsAt).toBe(t(23, 30));
  });

  it("does not call an ordinary quiet evening an outage", () => {
    // A five-hour lull is below the floor; a detector with no floor hands the DON phantom nights.
    expect(detectOutageWindows([t(18), t(23)], t(23, 10))).toHaveLength(0);
    expect(OUTAGE_GAP_FLOOR_MINUTES).toBe(360);
  });

  it("closes the TRAILING gap — an outage still running is the one that matters most", () => {
    const windows = detectOutageWindows([t(12)], t(23));
    expect(windows).toHaveLength(1);
    expect(windows[0]?.endsAt).toBe(t(23));
  });

  it("puts one worklist row on every shift that OVERLAPPED, and none that merely touched", () => {
    const window: OutageWindow = {
      startsAt: t(19),
      endsAt: t(23, 30),
      durationMinutes: 270,
    };
    const { rows, effects } = buildPaperReentryWorklist(window, [
      {
        shiftId: "s-overlap",
        shiftStartsAt: t(18),
        shiftEndsAt: t(23, 59),
        assignedToMembershipId: RN,
      },
      // Ends exactly when the outage starts — never affected by it.
      { shiftId: "s-before", shiftStartsAt: t(12), shiftEndsAt: t(19), assignedToMembershipId: RN },
      // Starts exactly when the outage ends.
      {
        shiftId: "s-after",
        shiftStartsAt: t(23, 30),
        shiftEndsAt: t(23, 59),
        assignedToMembershipId: RN,
      },
    ]);
    expect(rows.map((r) => r.shiftId)).toEqual(["s-overlap"]);
    // outage end + 72 h.
    expect(rows[0]?.expiresAt).toBe(new Date(Date.UTC(2026, 7, 2, 23, 30, 0)).toISOString());
    expect(effects.length).toBeGreaterThan(0);
  });

  it("raises no alert when nothing is outstanding", () => {
    const { rows, effects } = buildPaperReentryWorklist(
      { startsAt: t(19), endsAt: t(23), durationMinutes: 240 },
      [],
    );
    expect(rows).toEqual([]);
    expect(effects).toEqual([]);
  });

  it("§2.7 steps 1–2 — the three paper-origin columns are one fact", () => {
    expectCode(
      () =>
        assertPaperOriginCoherent(
          {
            source: "manual",
            paperOriginFlag: true,
            paperOriginalOpenedAt: t(20),
            openedAt: t(20),
          },
          NOW,
        ),
      "PAPER_ORIGIN_FIELDS_INCOHERENT",
    );
    expectCode(
      () =>
        assertPaperOriginCoherent(
          {
            source: "paper_origin",
            paperOriginFlag: true,
            paperOriginalOpenedAt: null,
            openedAt: t(20),
          },
          NOW,
        ),
      "PAPER_ORIGIN_FIELDS_INCOHERENT",
    );
    // `opened_at` IS the original call time on a paper-origin row, not the re-entry clock.
    expectCode(
      () =>
        assertPaperOriginCoherent(
          {
            source: "paper_origin",
            paperOriginFlag: true,
            paperOriginalOpenedAt: t(20),
            openedAt: NOW.toISOString(),
          },
          NOW,
        ),
      "PAPER_ORIGIN_FIELDS_INCOHERENT",
    );
    expect(() =>
      assertPaperOriginCoherent(
        {
          source: "paper_origin",
          paperOriginFlag: true,
          paperOriginalOpenedAt: t(20),
          openedAt: t(20),
        },
        NOW,
      ),
    ).not.toThrow();
  });

  it("refuses an original call time outside the outage window it is filed against", () => {
    const window: OutageWindow = { startsAt: t(19), endsAt: t(23), durationMinutes: 240 };
    expectCode(
      () => assertWithinOutageWindow(t(12), window),
      "PAPER_REENTRY_OUTSIDE_OUTAGE_WINDOW",
    );
    expect(() => assertWithinOutageWindow(t(20), window)).not.toThrow();
  });

  it("links a worklist row once, and never after it expires", () => {
    const worklist = {
      worklistId: "w-1",
      expiresAt: "2026-08-02T23:00:00.000Z",
      reenteredAt: null,
      linkedTriageCallId: null,
    };
    const effects = linkPaperReentry({
      worklist,
      triageCallId: "call-1",
      at: "2026-07-31T09:00:00.000Z",
    });
    expect(effects).toContainEqual({ kind: "link_paper_reentry_worklist", worklistId: "w-1" });
    expectCode(
      () =>
        linkPaperReentry({
          worklist: { ...worklist, reenteredAt: "x", linkedTriageCallId: "call-0" },
          triageCallId: "call-1",
          at: "2026-07-31T09:00:00.000Z",
        }),
      "PAPER_REENTRY_ALREADY_LINKED",
    );
    expectCode(
      () =>
        linkPaperReentry({
          worklist,
          triageCallId: "call-1",
          at: "2026-08-03T09:00:00.000Z",
        }),
      "PAPER_REENTRY_WORKLIST_EXPIRED",
    );
  });
});
