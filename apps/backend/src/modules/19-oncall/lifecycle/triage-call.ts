// apps/backend/src/modules/19-oncall/lifecycle/triage-call.ts — M19-T03 (§2.2.1, §2.3, §2.5, D6, D8).
//
// THE CALL MACHINE. Nine states, ten commands, and one property that is easy to lose: the transition table
// is a WHITELIST, not a rank order. Two legal edges run "backwards" —
//
//   `awaiting_callback → protocol_in_progress`  (§2.2.1 `resumeAfterCallback`)
//   `escalated_unresolved → documented_pending_encounter`  (§2.2.1 `resolveEscalation`)
//
// — and a machine implemented as "the new state must rank above the old" silently forbids the second,
// stranding every escalated call forever. Migration 0108's forward-transition trigger is a whitelist for
// exactly this reason (M19-T02's finding); this file is its application-layer twin, and the two lists are
// asserted equal by the §9 tests.
//
// The machine is PURE: every fact it reasons over is injected, it performs no IO and reads no clock beyond
// the `at` it is handed. Each transition returns the new state plus a DECLARATIVE side-effect list
// (./effects) the M19-T07 route layer executes inside one transaction — so the `triage_call` row, its
// `triage_call_state_history` row, the M4 audit row and the §4.10 outbox row commit together or not at all.
//
// M19-F06 / ADR-0022 shapes the tail of the lifecycle: disposition selection does NOT reach `documented`.
// It parks the call in `documented_pending_encounter` and invokes M8's `EncounterCreator`; `documented`
// arrives only when `m8.encounter.signed` lands for the linked encounter (D8). That intermediate state is
// also where §2.7's degraded class D-B strands a call when M8 is unreachable — which is why
// `TRIAGE_CALL_OPEN_STATES` (@wardenx/types, M19-T01) deliberately includes it: a call the supervisor can
// no longer see is a call nobody will rescue.
import type {
  IsoInstant,
  MembershipId,
  TriageCallState,
  TriageDisposition,
  TriageDispositionData,
  TriageEscalationTier,
} from "@wardenx/types";
import { TRIAGE_DOCUMENTED_CLOSE_GRACE_MINUTES } from "@wardenx/types";
import {
  type SelectableDisposition,
  assertDispositionInScope,
  assertDispositionPayload,
  dispositionEffects,
} from "./disposition";
import {
  type TriageSideEffect,
  type TriageTransitionResult,
  result,
  withAuditAndHistory,
} from "./effects";
import { TriageStateError, require_ } from "./errors";
import {
  type TriageEscalationFacts,
  assertCallCloseable,
  hasOpenRedFlagEscalation,
  hasUnacknowledgedMandatoryEscalation,
} from "./escalation";
import {
  type TriageActorDiscipline,
  type TriageAnswerFacts,
  type TriageProtocolQuestionFacts,
  unansweredRequiredQuestions,
} from "./protocol";

/** §2.2.1 — the commands. Named exactly as the spec's transition table names them. */
export type TriageCallCommand =
  | "applyProtocol"
  | "completeProtocol"
  | "markAwaitingCallback"
  | "resumeAfterCallback"
  | "selectDisposition"
  | "escalateUnresolved"
  | "resolveEscalation"
  | "markDocumented"
  | "closeCall"
  | "markAbandoned";

/** One legal edge of §2.2.1. */
export interface TriageCallEdge {
  readonly from: TriageCallState;
  readonly command: TriageCallCommand;
  readonly to: TriageCallState;
}

/**
 * §2.2.1 — the transition table, verbatim. `markAbandoned` is expanded per source state because "any state
 * → abandoned" in the spec's diagram means any NON-TERMINAL state: abandoning a `documented` call would
 * discard a signed encounter's context, and abandoning an already-`abandoned` one writes a history row
 * whose from- and to-state are equal (the §3.3 `m19_triage_call_state_history_changed` CHECK refuses it).
 */
export const TRIAGE_CALL_EDGES: readonly TriageCallEdge[] = [
  { from: "open", command: "applyProtocol", to: "protocol_in_progress" },
  { from: "protocol_in_progress", command: "completeProtocol", to: "disposition_pending" },
  { from: "protocol_in_progress", command: "markAwaitingCallback", to: "awaiting_callback" },
  // The documented backwards edge: a caller who could not be reached resumes the same walk.
  { from: "awaiting_callback", command: "resumeAfterCallback", to: "protocol_in_progress" },
  {
    from: "disposition_pending",
    command: "selectDisposition",
    to: "documented_pending_encounter",
  },
  { from: "disposition_pending", command: "escalateUnresolved", to: "escalated_unresolved" },
  // The second backwards edge — the one a rank comparison silently forbids.
  {
    from: "escalated_unresolved",
    command: "resolveEscalation",
    to: "documented_pending_encounter",
  },
  { from: "documented_pending_encounter", command: "markDocumented", to: "documented" },
  { from: "documented", command: "closeCall", to: "closed" },
  { from: "open", command: "markAbandoned", to: "abandoned" },
  { from: "protocol_in_progress", command: "markAbandoned", to: "abandoned" },
  { from: "awaiting_callback", command: "markAbandoned", to: "abandoned" },
  { from: "disposition_pending", command: "markAbandoned", to: "abandoned" },
  { from: "escalated_unresolved", command: "markAbandoned", to: "abandoned" },
];

/** The states no command advances out of (§2.2.1). Mirrors `TRIAGE_CALL_TERMINAL_STATES` in
 *  @wardenx/types; asserted equal by the §9 contract test. */
const TERMINAL: readonly TriageCallState[] = ["closed", "abandoned"];

/** Resolve the edge for `(from, command)`, or refuse. `.find()` is safe here — the table above has no
 *  `(from, command)` pair with two targets (M21-T03's finding: a duplicate key silently picks the first). */
export function resolveEdge(from: TriageCallState, command: TriageCallCommand): TriageCallEdge {
  require_(
    !TERMINAL.includes(from),
    "TRIAGE_CALL_TERMINAL",
    `a call in '${from}' is terminal; no command advances it`,
  );
  const edge = TRIAGE_CALL_EDGES.find((e) => e.from === from && e.command === command);
  if (edge === undefined) {
    throw new TriageStateError(
      "INVALID_STATE_TRANSITION",
      `'${command}' is not a legal command from '${from}'`,
    );
  }
  return edge;
}

/** The commands legal from a state — what the §5 panel renders as available actions. */
export function availableCommands(from: TriageCallState): readonly TriageCallCommand[] {
  if (TERMINAL.includes(from)) return [];
  return TRIAGE_CALL_EDGES.filter((e) => e.from === from).map((e) => e.command);
}

/** §2.5 — optimistic concurrency. A supervisor reading while the RN answers is the ordinary case; the
 *  second writer gets 412 with the current row state rather than silently overwriting the first. */
export function assertVersion(current: number, expected: number): void {
  require_(
    current === expected,
    "STALE_VERSION",
    `the call has moved on (version ${current}, you sent ${expected})`,
  );
}

/** One `triage_call` row as the machine sees it — the §2.2.1 columns and nothing more. */
export interface TriageCallFacts {
  readonly state: TriageCallState;
  readonly version: number;
  readonly selectedProtocolId: string | null;
  readonly linkedEncounterId: string | null;
  readonly firstResponseAt: IsoInstant | null;
  readonly documentedAt: IsoInstant | null;
  readonly paperOriginFlag: boolean;
}

/** A transition of the call machine. */
export type TriageCallTransition = TriageTransitionResult<TriageCallState, TriageCallCommand>;

// ── The commands ──────────────────────────────────────────────────────────────────────────────────────

/**
 * §2.2.1 `protocol_in_progress → disposition_pending` (`completeProtocol`).
 *
 * Both §2.3 gates run here and both refuse in the safe direction:
 *   • every `required=true` question has an original answer — §1.1's "the API ignores any client-supplied
 *     'all questions answered' claim" made real;
 *   • no red-flag escalation is still open — a flag nobody has picked up is not a finding the walk may
 *     step past.
 */
export function completeProtocol(input: {
  readonly call: TriageCallFacts;
  readonly questions: readonly TriageProtocolQuestionFacts[];
  readonly answers: readonly TriageAnswerFacts[];
  readonly escalations: readonly TriageEscalationFacts[];
}): TriageCallTransition {
  const edge = resolveEdge(input.call.state, "completeProtocol");
  const missing = unansweredRequiredQuestions(input.questions, input.answers);
  require_(
    missing.length === 0,
    "REQUIRED_QUESTIONS_UNANSWERED",
    `${missing.length} required question(s) unanswered, first at order ${missing[0]?.questionOrder}`,
  );
  require_(
    !hasOpenRedFlagEscalation(input.escalations),
    "RED_FLAG_ESCALATION_UNRESOLVED",
    "a red-flag answer raised an escalation that nobody has acknowledged yet",
  );

  return result(
    edge.from,
    edge.command,
    edge.to,
    withAuditAndHistory(edge.from, edge.to, false, []),
  );
}

/** §2.2.1 `protocol_in_progress → awaiting_callback`. The required-questions check is WAIVED (the caller is
 *  not reachable at this moment — that is the whole reason for the state) and the §4.8 callback SLA timer
 *  starts. The call stays in `TRIAGE_CALL_OPEN_STATES`, so it keeps its place on the supervisor board. */
export function markAwaitingCallback(input: {
  readonly call: TriageCallFacts;
  readonly reason: string;
}): TriageCallTransition {
  const edge = resolveEdge(input.call.state, "markAwaitingCallback");
  require_(
    input.reason.trim().length > 0,
    "CALLBACK_REASON_REQUIRED",
    "record why the caller could not be reached; the §4.8 SLA detector picks its target from it",
  );
  return result(
    edge.from,
    edge.command,
    edge.to,
    withAuditAndHistory(edge.from, edge.to, false, [
      { kind: "alert", alert: "m19.triage.callback_sla_breached" },
    ]),
  );
}

/** §2.2.1 `awaiting_callback → protocol_in_progress` — the documented backwards edge. The walk resumes at
 *  the question the server's own cursor is on; no answer is discarded and none is re-asked (§7.5). */
export function resumeAfterCallback(call: TriageCallFacts): TriageCallTransition {
  const edge = resolveEdge(call.state, "resumeAfterCallback");
  return result(
    edge.from,
    edge.command,
    edge.to,
    withAuditAndHistory(edge.from, edge.to, false, []),
  );
}

/**
 * §2.2.1 `disposition_pending → documented_pending_encounter` (D6 / D8 / M19-F06).
 *
 * Four refusals, in the order that leaks least: the §7.2 mandatory-escalation gate FIRST (an actor blocked
 * by it must not be able to probe which dispositions their role holds), then scope (§7.3), then the payload
 * (D6). Only then does the transition resolve.
 */
export function selectDisposition(input: {
  readonly call: TriageCallFacts;
  readonly escalations: readonly TriageEscalationFacts[];
  readonly actorDiscipline: TriageActorDiscipline;
  readonly disposition: TriageDisposition;
  readonly data: TriageDispositionData;
  readonly at: IsoInstant;
}): TriageCallTransition {
  require_(
    !hasUnacknowledgedMandatoryEscalation(input.escalations),
    "DISPOSITION_BLOCKED_BY_MANDATORY_ESCALATION",
    "a mandatory escalation is still unacknowledged; the call may only be handed off (escalateUnresolved) until the escalated party picks up",
  );
  assertDispositionInScope(input.actorDiscipline, input.disposition);
  assertDispositionPayload(input.disposition, input.data);

  const edge = resolveEdge(input.call.state, "selectDisposition");
  const disposition = input.disposition as SelectableDisposition;

  return result(
    edge.from,
    edge.command,
    edge.to,
    withAuditAndHistory(edge.from, edge.to, false, [
      { kind: "set_disposition", disposition, data: input.data },
      ...dispositionEffects(disposition),
    ]),
  );
}

/**
 * §2.2.1 `disposition_pending → escalated_unresolved`.
 *
 * The call stays OPEN — that is the point. `escalated_unresolved` is both the state and the disposition
 * written, and the row is created here rather than through `selectDisposition` because this command carries
 * the `triage.escalate` permission the plain disposition route does not (§6 / §7.3).
 */
export function escalateUnresolved(input: {
  readonly call: TriageCallFacts;
  readonly tier: TriageEscalationTier;
  readonly escalatedToMembershipId: MembershipId | null;
  readonly escalatedToExternalActorId: string | null;
  readonly reason: string;
}): TriageCallTransition {
  const edge = resolveEdge(input.call.state, "escalateUnresolved");
  require_(
    input.reason.trim().length > 0,
    "ESCALATION_RESOLUTION_REQUIRED",
    "record why the call is being handed off; the escalated party reads it before they call back",
  );

  return result(
    edge.from,
    edge.command,
    edge.to,
    withAuditAndHistory(edge.from, edge.to, false, [
      {
        kind: "create_escalation",
        tier: input.tier,
        triggerKind: "manual",
        mandatory: false,
        notifyTiers: [input.tier],
      },
      {
        kind: "set_disposition",
        disposition: "escalated_unresolved",
        data: { disposition: "escalated_unresolved", escalationId: "", tier: input.tier },
      },
      { kind: "outbox", event: "m19.triage_call.escalation_recorded" },
      { kind: "outbox", event: "m19.triage_call.disposition_selected" },
    ]),
  );
}

/**
 * §2.2.1 `escalated_unresolved → documented_pending_encounter` — the SECOND backwards edge.
 *
 * The escalated party resolved; the clinician now picks the real disposition with their guidance (§7.2's
 * worked sequence ends exactly here, with `gip_admission_proposed`). Every gate `selectDisposition` runs
 * runs again — the escalation being resolved does not widen the actor's scope of practice.
 */
export function resolveEscalationAndDisposition(input: {
  readonly call: TriageCallFacts;
  readonly escalations: readonly TriageEscalationFacts[];
  readonly actorDiscipline: TriageActorDiscipline;
  readonly disposition: TriageDisposition;
  readonly data: TriageDispositionData;
}): TriageCallTransition {
  require_(
    !hasUnacknowledgedMandatoryEscalation(input.escalations),
    "DISPOSITION_BLOCKED_BY_MANDATORY_ESCALATION",
    "the mandatory escalation has not been acknowledged; it cannot be resolved past",
  );
  assertDispositionInScope(input.actorDiscipline, input.disposition);
  assertDispositionPayload(input.disposition, input.data);

  const edge = resolveEdge(input.call.state, "resolveEscalation");
  const disposition = input.disposition as SelectableDisposition;

  return result(
    edge.from,
    edge.command,
    edge.to,
    withAuditAndHistory(edge.from, edge.to, false, [
      { kind: "set_disposition", disposition, data: input.data },
      ...dispositionEffects(disposition),
    ]),
  );
}

/**
 * §2.2.1 `documented_pending_encounter → documented` (D8) — a SYSTEM transition, driven by
 * `m8.encounter.signed` arriving for the linked encounter.
 *
 * The encounter id is checked against the one the call is linked to. An `m8.encounter.signed` for some
 * other encounter would otherwise advance a call whose own documentation is still unwritten — and because
 * this consumer is idempotent on the signed-event id, the mistake would be permanent.
 */
export function markDocumented(input: {
  readonly call: TriageCallFacts;
  readonly signedEncounterId: string;
  readonly at: IsoInstant;
}): TriageCallTransition {
  require_(
    input.call.linkedEncounterId !== null,
    "ENCOUNTER_NOT_LINKED",
    "the call has no linked M8 encounter yet (the §2.7 D-B degraded park); the encounter-creator worker retries until M8 recovers",
  );
  require_(
    input.call.linkedEncounterId === input.signedEncounterId,
    "ENCOUNTER_LINK_MISMATCH",
    `encounter ${input.signedEncounterId} is not the encounter linked to this call`,
  );

  const edge = resolveEdge(input.call.state, "markDocumented");
  return result(
    edge.from,
    edge.command,
    edge.to,
    // systemActor: true — no membership took this action; the §3.3 attribution CHECK requires the flag.
    withAuditAndHistory(edge.from, edge.to, true, [
      { kind: "set_timestamp", field: "documented_at", at: input.at },
      { kind: "outbox", event: "m19.triage_call.documented" },
      { kind: "alert", alert: "m19.triage.documented" },
    ]),
  );
}

/**
 * §2.2.1 `documented → closed` — the `triage.close` worker, after the 30-minute amendment grace.
 *
 * Two guards, both fail-closed. The grace window protects a clinician still amending; the escalation check
 * (§2.2.4) refuses to let a close clear a mandatory row by lapse. Non-mandatory acknowledged escalations
 * auto-resolve here — `autoResolveOnCallClose` returns those effects, which the caller appends.
 */
export function closeCall(input: {
  readonly call: TriageCallFacts;
  readonly escalations: readonly TriageEscalationFacts[];
  readonly at: IsoInstant;
}): TriageCallTransition {
  const edge = resolveEdge(input.call.state, "closeCall");
  require_(
    input.call.documentedAt !== null,
    "DOCUMENTED_CLOSE_GRACE_NOT_ELAPSED",
    "the call has no documented_at; the grace window has not started",
  );
  const elapsedMinutes =
    (new Date(input.at).getTime() - new Date(input.call.documentedAt).getTime()) / 60_000;
  require_(
    elapsedMinutes >= TRIAGE_DOCUMENTED_CLOSE_GRACE_MINUTES,
    "DOCUMENTED_CLOSE_GRACE_NOT_ELAPSED",
    `${TRIAGE_DOCUMENTED_CLOSE_GRACE_MINUTES}-minute amendment grace has not elapsed (${Math.floor(elapsedMinutes)} min)`,
  );
  assertCallCloseable(input.escalations);

  return result(
    edge.from,
    edge.command,
    edge.to,
    withAuditAndHistory(edge.from, edge.to, true, [
      { kind: "set_timestamp", field: "closed_at", at: input.at },
      { kind: "outbox", event: "m19.triage_call.closed" },
    ]),
  );
}

/**
 * §2.2.1 — `markAbandoned(reason)` from any non-terminal state. The caller hung up.
 *
 * A mandatory escalation still blocks: §2.2.4's rule is about the ROW, not about how the call ended, and
 * "the caller disconnected" is not an answer to "did a human respond to the suicidal-ideation page?".
 * Abandoning around it would be the cheapest suppression path in the module.
 */
export function markAbandoned(input: {
  readonly call: TriageCallFacts;
  readonly escalations: readonly TriageEscalationFacts[];
  readonly reason: string;
  readonly callbackAttempts: number;
  readonly at: IsoInstant;
}): TriageCallTransition {
  const edge = resolveEdge(input.call.state, "markAbandoned");
  require_(
    input.reason.trim().length > 0,
    "ABANDON_REASON_REQUIRED",
    "record what the caller said before disconnecting; without it the row says a call happened and nothing else",
  );
  assertCallCloseable(input.escalations);

  return result(
    edge.from,
    edge.command,
    edge.to,
    withAuditAndHistory(edge.from, edge.to, false, [
      {
        kind: "set_disposition",
        disposition: "abandoned",
        data: {
          disposition: "abandoned",
          reason: input.reason,
          callbackAttempts: input.callbackAttempts,
        },
      },
      { kind: "set_timestamp", field: "closed_at", at: input.at },
      { kind: "outbox", event: "m19.triage_call.closed" },
    ]),
  );
}

/** §2.4 — the effects of OPENING a call. Not a transition (there is no prior state), but it writes the
 *  same two invariants plus the §4.9 alert whose severity §4.9 makes conditional: a machine-opened call
 *  (D10's M17 no-show / M18 late-checkout triggers) is `warn` rather than `info`, because nobody has
 *  necessarily looked at it yet. */
export function openCallEffects(input: {
  readonly machineOpened: boolean;
  readonly at: IsoInstant;
}): ReadonlyArray<TriageSideEffect> {
  return withAuditAndHistory(null, "open", input.machineOpened, [
    { kind: "outbox", event: "m19.triage_call.opened" },
    { kind: "alert", alert: "m19.triage.case_opened" },
    ...(input.machineOpened
      ? []
      : ([{ kind: "set_timestamp", field: "first_response_at", at: input.at }] as const)),
  ]);
}
