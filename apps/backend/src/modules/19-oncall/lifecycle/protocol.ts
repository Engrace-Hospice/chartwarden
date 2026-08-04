// apps/backend/src/modules/19-oncall/lifecycle/protocol.ts — M19-T03 (§2.2 / §2.3 / D4 / D5 / D7 / §7.3).
//
// THE PROTOCOL ENGINE. Three jobs, all server-authoritative (§1.1: "the API ignores any client-supplied
// 'all questions answered' claim"):
//
//   1. APPLY (D4) — resolve which protocol may be applied to this call by this actor at this instant, and
//      PIN its version. The pin is the whole point of effective-dating: a catalog revision published
//      mid-call must not re-key the answers already recorded against the version the caller was walked
//      through. §2.2.1's `applyProtocol` is the only writer of `selected_protocol_id`.
//   2. GATE (D5) — the ordered walk. `assertAnswerInOrder` is what makes §7.1's
//      `PROTOCOL_QUESTION_OUT_OF_ORDER` real: an out-of-order POST is refused rather than tolerated,
//      because a protocol sampled instead of walked can skip the one question that mattered.
//   3. EVALUATE (D5) — `evaluateRedFlag` decides whether an answer trips its question's `red_flag_match`.
//      The client never asserts a red flag; it answers a question and the server decides. That asymmetry
//      IS the control — `triage_call_answer.red_flag_hit` is deliberately outside the §3.6 audit denylist
//      because it is the tamper-evidence a suppression investigation reads.
//
// D7's mandatory escalation is decided here too (`mandatoryEscalationFor`), because "which protocols force
// a page regardless of disposition" is a property of the CATALOG ROW, not of the call. Four platform-floor
// protocols carry it (§1.1) and no tenant configuration can clear the flag — the floor rows are org-less
// and `is_system_locked`, so migration 0108's INSERT/UPDATE policies make the tenant physically unable to
// write them. This file is the second net: it refuses to apply a `requires_mandatory_escalation` protocol
// that names no tier, rather than applying it and discovering at 2 a.m. that the page routed to nobody.
import type {
  IsoInstant,
  MembershipId,
  TriageEscalationTier,
  TriageProtocolAnswerType,
  TriageProtocolId,
  TriageProtocolQuestionId,
  TriageRedFlagMatch,
} from "@wardenx/types";
import { type TriageSideEffect, withAudit, withAuditAndHistory } from "./effects";
import { TriageStateError, require_ } from "./errors";

// ── Facts the engine reasons over (already-resolved rows; no IO in this file) ─────────────────────────

/** One `triage_protocol` row as the engine sees it. */
export interface TriageProtocolFacts {
  readonly protocolId: TriageProtocolId;
  readonly key: string;
  readonly chiefComplaintLabel: string;
  /** NULL ⇔ the platform-floor row every tenant reads (§3.3 CHECK pair). */
  readonly organizationId: string | null;
  readonly isSystemLocked: boolean;
  readonly disciplineRequired: TriageActorDiscipline;
  readonly requiresMandatoryEscalation: boolean;
  readonly mandatoryEscalationTier: TriageEscalationTier | null;
  readonly version: string;
  readonly effectiveFrom: IsoInstant;
  readonly effectiveTo: IsoInstant | null;
}

/** One `triage_protocol_question` row as the engine sees it. */
export interface TriageProtocolQuestionFacts {
  readonly questionId: TriageProtocolQuestionId;
  readonly protocolId: TriageProtocolId;
  readonly questionOrder: number;
  readonly prompt: string;
  readonly answerType: TriageProtocolAnswerType;
  readonly answerEnumValues: readonly string[] | null;
  readonly required: boolean;
  readonly isRedFlagQuestion: boolean;
  readonly redFlagMatch: TriageRedFlagMatch | null;
}

/** One already-recorded `triage_call_answer` row. */
export interface TriageAnswerFacts {
  readonly answerId: string;
  readonly questionId: TriageProtocolQuestionId;
  readonly correctionOfAnswerId: string | null;
  readonly redFlagHit: boolean;
}

/** The typed value an answer carries — exactly one column, mirroring the §3.3 `num_nonnulls(...) = 1`
 *  CHECK. Expressed as a discriminated union so "exactly one" is a type fact before it is a DB fact. */
export type TriageAnswerValue =
  | { readonly kind: "text"; readonly value: string }
  | { readonly kind: "int"; readonly value: number }
  | { readonly kind: "bool"; readonly value: boolean };

/**
 * §7.3 / §6 — the clinical scope of the actor walking the protocol. Deliberately the
 * `oncall_shift_discipline` vocabulary (§3.2) rather than an M3 role key: scope of practice is a
 * DISCIPLINE fact ("an LPN may not exercise clinician judgment"), and M19 already spells disciplines in
 * that enum. `supervisor` is the Clin Supv / DON / TN band that §6 grants the full disposition set.
 */
export type TriageActorDiscipline =
  | "clinical_rn"
  | "clinical_lpn"
  | "medical_director"
  | "msw"
  | "chaplain"
  | "supervisor"
  | "external";

/** §7.3 — the scope ladder. A protocol's `discipline_required` is the FLOOR; anyone at or above it may
 *  run it. `msw`, `chaplain` and `external` are not on the clinical ladder: each may run only protocols
 *  written for it (a psychosocial-crisis protocol is `msw`; a vendor-facing one is `external`). */
const CLINICAL_LADDER: readonly TriageActorDiscipline[] = [
  "clinical_lpn",
  "clinical_rn",
  "supervisor",
  "medical_director",
];

/**
 * §7.3 — may `actor` run a protocol whose floor is `required`?
 *
 * Two rules, not one. On the clinical ladder it is a rank comparison (an RN may run an LPN protocol).
 * OFF the ladder it is exact match — an MSW is not "below" an RN, they are a different discipline, and
 * ranking them would either let an MSW run a cardiac protocol or forbid an MSW protocol to the MSW it was
 * written for. A clinical actor may additionally run an `msw` / `chaplain` protocol, because the on-call
 * RN taking a psychosocial-crisis call at 2 a.m. is exactly the §7.9 / §1.1 scenario the catalog covers.
 */
export function disciplineSatisfies(
  actor: TriageActorDiscipline,
  required: TriageActorDiscipline,
): boolean {
  const actorRank = CLINICAL_LADDER.indexOf(actor);
  const requiredRank = CLINICAL_LADDER.indexOf(required);
  if (actorRank >= 0 && requiredRank >= 0) return actorRank >= requiredRank;
  if (actorRank >= 0 && (required === "msw" || required === "chaplain")) return true;
  return actor === required;
}

// ── 1. APPLY (D4) ─────────────────────────────────────────────────────────────────────────────────────

/** §2.3 / D4 — is the protocol usable at this instant? A window is half-open: `effective_from` inclusive,
 *  `effective_to` exclusive, so a supersession at midnight leaves no instant covered twice. */
export function isProtocolEffectiveAt(protocol: TriageProtocolFacts, at: Date): boolean {
  if (at.getTime() < new Date(protocol.effectiveFrom).getTime()) return false;
  if (protocol.effectiveTo === null) return true;
  return at.getTime() < new Date(protocol.effectiveTo).getTime();
}

/** D4 — the catalog read a tenant is entitled to: the platform floor plus its OWN rows. Mirrors migration
 *  0108's SELECT policy (`organization_id IS NULL OR organization_id = app.org_id`) at the layer that can
 *  say WHY, so a mis-scoped protocol id is a 422 with a reason rather than an empty result set. */
export function isProtocolVisibleTo(protocol: TriageProtocolFacts, orgId: string): boolean {
  return protocol.organizationId === null || protocol.organizationId === orgId;
}

/** D7 — the escalation tier a protocol forces, or `null` when it forces none. Refuses the incoherent row
 *  (`requires_mandatory_escalation` with no tier) rather than treating it as "no escalation": the §3.3
 *  CHECK makes that row impossible in the database, and silently downgrading it here would re-open the
 *  exact hole the CHECK closes. */
export function mandatoryEscalationFor(protocol: TriageProtocolFacts): TriageEscalationTier | null {
  if (!protocol.requiresMandatoryEscalation) return null;
  if (protocol.mandatoryEscalationTier === null) {
    throw new TriageStateError(
      "PROTOCOL_MANDATORY_TIER_MISSING",
      `protocol '${protocol.key}' requires a mandatory escalation but names no tier`,
    );
  }
  return protocol.mandatoryEscalationTier;
}

/**
 * §7.2 — who M36 tells when a mandatory escalation fires.
 *
 * The `triage_escalation` ROW carries exactly one tier (the §3.3 recipient CHECK admits one recipient), and
 * that tier is the protocol's own. The ALERT fan-out is wider: §7.2's "recipient set computed from
 * `tenant_oncall_policy.escalation_tiers`" and §1.1's "always to MSW + medical director" both describe
 * telling more than one party. The on-call supervisor is always included because it is THEIR shift the
 * crisis is happening on — a medical director paged about a patient whose on-call RN does not know is a
 * split picture at the worst possible moment.
 *
 * `tier_5_external` is the exception: a vendor actor is not an agency escalation path, so a mandatory
 * escalation never fans out to it. (No platform-floor protocol routes there; the guard is for tenant rows.)
 */
export function mandatoryEscalationNotifyTiers(
  tier: TriageEscalationTier,
): readonly TriageEscalationTier[] {
  if (tier === "tier_5_external") return [tier];
  if (tier === "tier_1_rn_supervisor") return [tier];
  return ["tier_1_rn_supervisor", tier];
}

/** The context `applyProtocol` decides over. */
export interface ApplyProtocolContext {
  readonly orgId: string;
  readonly protocol: TriageProtocolFacts;
  readonly actorDiscipline: TriageActorDiscipline;
  readonly at: Date;
  /** D12 — the M32-suggested protocol id, when a suggestion was offered. `null` ⇒ no AI surface (the
   *  tenant gate is off, or the seam was deny-stubbed / timed out per §2.7 class D-A). */
  readonly suggestedProtocolId: TriageProtocolId | null;
}

/** What `applyProtocol` decided, beyond the effect list. */
export interface ApplyProtocolDecision {
  readonly pinnedVersion: string;
  readonly mandatoryTier: TriageEscalationTier | null;
  /** D12 — `true` when the clinician took the suggestion, `false` when they overrode it, `null` when
   *  there was no suggestion to take. The AI-governance audit (§8.6) requires an override reason; the
   *  route layer collects it, this flag is what tells it to. */
  readonly aiAccepted: boolean | null;
}

/**
 * §2.2.1 `open → protocol_in_progress` (D4 + §7.3 + D7).
 *
 * Order of refusals is deliberate: VISIBILITY before EFFECTIVENESS before SCOPE. A protocol from another
 * tenant must not be distinguishable from a retired one by its error message, and neither must leak the
 * fact that it exists at all before the actor's own scope has been checked.
 */
export function applyProtocol(context: ApplyProtocolContext): {
  readonly decision: ApplyProtocolDecision;
  readonly effects: ReadonlyArray<TriageSideEffect>;
} {
  const { protocol, orgId, actorDiscipline, at } = context;

  require_(
    isProtocolVisibleTo(protocol, orgId),
    "PROTOCOL_NOT_AVAILABLE",
    `protocol ${protocol.protocolId} is not in this organization's catalog`,
  );
  require_(
    isProtocolEffectiveAt(protocol, at),
    "PROTOCOL_NOT_EFFECTIVE",
    `protocol '${protocol.key}' v${protocol.version} is not effective at ${at.toISOString()} (window ${protocol.effectiveFrom} → ${protocol.effectiveTo ?? "open"})`,
  );
  require_(
    disciplineSatisfies(actorDiscipline, protocol.disciplineRequired),
    "PROTOCOL_OUT_OF_DISCIPLINE_SCOPE",
    `protocol '${protocol.key}' requires ${protocol.disciplineRequired}; actor is ${actorDiscipline}`,
  );

  const mandatoryTier = mandatoryEscalationFor(protocol);
  const aiAccepted =
    context.suggestedProtocolId === null
      ? null
      : context.suggestedProtocolId === protocol.protocolId;

  const effects: TriageSideEffect[] = [
    {
      kind: "pin_protocol",
      protocolId: protocol.protocolId,
      version: protocol.version,
      aiAccepted,
    },
    { kind: "outbox", event: "m19.triage_call.protocol_applied" },
  ];

  // D7 / §7.2 — the escalation row is written in the SAME transaction as the protocol application. There
  // is no code path that applies the protocol without it: the effect is appended here, and the route layer
  // executes the whole list inside one transaction, so a failure to write it rolls the application back.
  if (mandatoryTier !== null) {
    effects.push(
      {
        kind: "create_escalation",
        tier: mandatoryTier,
        triggerKind: "mandatory_protocol",
        mandatory: true,
        notifyTiers: mandatoryEscalationNotifyTiers(mandatoryTier),
      },
      { kind: "outbox", event: "m19.triage_call.escalation_recorded" },
      { kind: "alert", alert: "m19.triage.mandatory_escalation_triggered" },
    );
  }

  return {
    decision: { pinnedVersion: protocol.version, mandatoryTier, aiAccepted },
    effects: withAuditAndHistory("open", "protocol_in_progress", false, effects),
  };
}

// ── 2. GATE (D5 — the ordered walk) ───────────────────────────────────────────────────────────────────

/** The questions of a protocol, ordered. Sorting here rather than trusting the caller's order is what
 *  makes `assertAnswerInOrder` mean the same thing whatever the read produced. */
export function orderedQuestions(
  questions: readonly TriageProtocolQuestionFacts[],
): readonly TriageProtocolQuestionFacts[] {
  return [...questions].sort((a, b) => a.questionOrder - b.questionOrder);
}

/** ORIGINAL answers only — corrections are additional rows (§2.2.3) and answer no NEW question. */
function originalAnswers(answers: readonly TriageAnswerFacts[]): readonly TriageAnswerFacts[] {
  return answers.filter((a) => a.correctionOfAnswerId === null);
}

/**
 * §7.1 / D5 — the next question the walk expects, or `null` when every question has an original answer.
 * This is the server's own cursor; the client renders from it and cannot move it.
 */
export function nextUnansweredQuestion(
  questions: readonly TriageProtocolQuestionFacts[],
  answers: readonly TriageAnswerFacts[],
): TriageProtocolQuestionFacts | null {
  const answered = new Set(originalAnswers(answers).map((a) => a.questionId));
  return orderedQuestions(questions).find((q) => !answered.has(q.questionId)) ?? null;
}

/**
 * §7.1 VERBATIM — `PROTOCOL_QUESTION_OUT_OF_ORDER`. The answer must be for the question the walk is
 * actually on. A CORRECTION (`isCorrection`) is exempt: §2.2.3's amend-by-append is how a clinician fixes
 * question 2 after answering question 5, and forbidding it would push them to abandon and re-open the call.
 */
export function assertAnswerInOrder(input: {
  readonly question: TriageProtocolQuestionFacts;
  readonly questions: readonly TriageProtocolQuestionFacts[];
  readonly answers: readonly TriageAnswerFacts[];
  readonly protocolId: TriageProtocolId;
  readonly isCorrection: boolean;
}): void {
  const { question, questions, answers, protocolId, isCorrection } = input;

  require_(
    question.protocolId === protocolId,
    "PROTOCOL_QUESTION_NOT_IN_PROTOCOL",
    `question ${question.questionId} belongs to protocol ${question.protocolId}, not the pinned ${protocolId}`,
  );
  if (isCorrection) return;

  const alreadyAnswered = originalAnswers(answers).some(
    (a) => a.questionId === question.questionId,
  );
  require_(
    !alreadyAnswered,
    "PROTOCOL_QUESTION_ALREADY_ANSWERED",
    `question ${question.questionId} already has an original answer; a change is a correction row (§2.2.3)`,
  );

  const expected = nextUnansweredQuestion(questions, answers);
  require_(
    expected !== null && expected.questionId === question.questionId,
    "PROTOCOL_QUESTION_OUT_OF_ORDER",
    `expected question order ${expected?.questionOrder ?? "none"}, received ${question.questionOrder}`,
  );
}

/** §2.2.3 — a correction chains to an ORIGINAL row on this call, never to another correction. */
export function assertCorrectionTarget(
  answers: readonly TriageAnswerFacts[],
  correctionOfAnswerId: string,
  questionId: TriageProtocolQuestionId,
): void {
  const target = answers.find((a) => a.answerId === correctionOfAnswerId);
  require_(
    target !== undefined,
    "CORRECTION_TARGET_NOT_FOUND",
    `answer ${correctionOfAnswerId} is not an answer on this call`,
  );
  require_(
    target.correctionOfAnswerId === null,
    "CORRECTION_OF_CORRECTION_FORBIDDEN",
    "a correction amends the original answer, not another correction",
  );
  require_(
    target.questionId === questionId,
    "CORRECTION_TARGET_NOT_FOUND",
    `answer ${correctionOfAnswerId} answers a different question`,
  );
}

/** Which typed column each `answer_type` writes. A closed mapping so a new answer type cannot be added
 *  without deciding — at compile time — which column its red-flag predicate reads. */
export const ANSWER_VALUE_KIND: {
  readonly [K in TriageProtocolAnswerType]: TriageAnswerValue["kind"];
} = {
  boolean: "bool",
  integer: "int",
  scale_0_10: "int",
  free_text: "text",
  enum: "text",
} as const;

/** §3.3 — the value must match the question's declared type, be non-blank, and (for `enum`) name a member
 *  of the question's own value list. A `scale_0_10` outside 0–10 is refused for the same reason a wrong
 *  column is: D5's threshold predicates would evaluate against a number the scale cannot produce. */
export function assertAnswerValueValid(
  question: TriageProtocolQuestionFacts,
  value: TriageAnswerValue,
): void {
  const expectedKind = ANSWER_VALUE_KIND[question.answerType];
  require_(
    value.kind === expectedKind,
    "ANSWER_VALUE_TYPE_MISMATCH",
    `question ${question.questionId} is '${question.answerType}' and takes the ${expectedKind} column, received ${value.kind}`,
  );
  if (value.kind === "text") {
    require_(
      value.value.trim().length > 0,
      "ANSWER_VALUE_REQUIRED",
      "an answer must record a value; 'unable to answer' is a recorded value, not a blank one",
    );
  }
  if (question.answerType === "enum") {
    const allowed = question.answerEnumValues ?? [];
    require_(
      value.kind === "text" && allowed.includes(value.value),
      "ANSWER_VALUE_TYPE_MISMATCH",
      `'${value.kind === "text" ? value.value : String(value.value)}' is not one of [${allowed.join(", ")}]`,
    );
  }
  if (question.answerType === "scale_0_10") {
    require_(
      value.kind === "int" &&
        Number.isInteger(value.value) &&
        value.value >= 0 &&
        value.value <= 10,
      "ANSWER_VALUE_TYPE_MISMATCH",
      "a 0–10 scale answer must be an integer in [0, 10]",
    );
  }
  if (question.answerType === "integer") {
    require_(
      value.kind === "int" && Number.isInteger(value.value),
      "ANSWER_VALUE_TYPE_MISMATCH",
      "an integer answer must be an integer",
    );
  }
}

// ── 3. EVALUATE (D5 — the red flag) ───────────────────────────────────────────────────────────────────

/**
 * D5 — does this answer trip its question's `red_flag_match`?
 *
 * A predicate whose arm does not match the recorded column returns FALSE, not an error: the arm/column
 * pairing is already guaranteed by `assertAnswerValueValid` running first, and a throw here would make an
 * answer un-recordable — which is the wrong failure direction on a red-flag question, because refusing the
 * write loses the answer AND the flag. A question with `is_red_flag_question=false` never fires (the §3.3
 * CHECK makes a red-flag question with no predicate impossible in the other direction).
 */
export function evaluateRedFlag(
  question: TriageProtocolQuestionFacts,
  value: TriageAnswerValue,
): boolean {
  if (!question.isRedFlagQuestion) return false;
  const match = question.redFlagMatch;
  if (match === null) return false;

  switch (match.kind) {
    case "bool_is":
      return value.kind === "bool" && value.value === match.value;
    case "int_at_least":
      return value.kind === "int" && value.value >= match.threshold;
    case "int_at_most":
      return value.kind === "int" && value.value <= match.threshold;
    case "enum_in":
      return value.kind === "text" && match.values.includes(value.value);
    case "text_any":
      return value.kind === "text" && value.value.trim().length > 0;
  }
}

/** The result of recording one answer. */
export interface RecordAnswerResult {
  readonly redFlagHit: boolean;
  readonly effects: ReadonlyArray<TriageSideEffect>;
}

/**
 * §2.2.3 / D5 — record one answer on a call already in `protocol_in_progress`.
 *
 * On a red-flag hit the `triage_escalation` row is created in the SAME transaction (§2.3's validation
 * table is explicit: "an open `triage_escalation` row MUST be created in same TX"). The tier is
 * `tier_1_rn_supervisor` — a red flag is a clinical concern raised to the shift supervisor, whereas D7's
 * MANDATORY escalations carry their own tier from the catalog row. Both write `red_flag_hit=true`; only
 * the mandatory one is un-auto-resolvable.
 *
 * This function does NOT change the call's state — `protocol_in_progress` is where the whole walk happens,
 * so there is no state-history row to append and `withAudit` (not `withAuditAndHistory`) is correct.
 */
export function recordAnswer(input: {
  readonly question: TriageProtocolQuestionFacts;
  readonly questions: readonly TriageProtocolQuestionFacts[];
  readonly answers: readonly TriageAnswerFacts[];
  readonly protocolId: TriageProtocolId;
  readonly value: TriageAnswerValue;
  readonly correctionOfAnswerId: string | null;
  readonly answeredByMembershipId: MembershipId;
}): RecordAnswerResult {
  const isCorrection = input.correctionOfAnswerId !== null;
  assertAnswerInOrder({
    question: input.question,
    questions: input.questions,
    answers: input.answers,
    protocolId: input.protocolId,
    isCorrection,
  });
  if (input.correctionOfAnswerId !== null) {
    assertCorrectionTarget(input.answers, input.correctionOfAnswerId, input.question.questionId);
  }
  assertAnswerValueValid(input.question, input.value);

  const redFlagHit = evaluateRedFlag(input.question, input.value);
  const effects: TriageSideEffect[] = [
    {
      kind: "record_answer",
      questionId: input.question.questionId,
      redFlagHit,
      isCorrection,
    },
  ];

  if (redFlagHit) {
    effects.push(
      {
        kind: "create_escalation",
        tier: "tier_1_rn_supervisor",
        triggerKind: "red_flag_question",
        mandatory: false,
        notifyTiers: ["tier_1_rn_supervisor"],
      },
      { kind: "outbox", event: "m19.triage_call.red_flag_hit" },
      { kind: "alert", alert: "m19.triage.protocol_red_flag_hit" },
    );
  }

  return { redFlagHit, effects: withAudit(effects) };
}

// ── Completion (§2.3's two gates on `completeProtocol`) ───────────────────────────────────────────────

/** §2.3 — the `required=true` questions with no original answer. Returned as a LIST rather than a boolean
 *  so the §5 stepper can jump the clinician to the first gap instead of saying "something is missing". */
export function unansweredRequiredQuestions(
  questions: readonly TriageProtocolQuestionFacts[],
  answers: readonly TriageAnswerFacts[],
): readonly TriageProtocolQuestionFacts[] {
  const answered = new Set(originalAnswers(answers).map((a) => a.questionId));
  return orderedQuestions(questions).filter((q) => q.required && !answered.has(q.questionId));
}
