// @wardenx/idg — §2.6 / §2.7 IDG decision recording, quorum, and adjournment emission (M14-T03). Pure.
//
// The decision aggregate is the canonical write-out to the rest of the system (§1.1). A decision is
// RECORDED while the meeting is `live` (status `open`, quorum stamped), EMITTED at adjournment (status
// `emitted`, one `idg.decision_recorded` outbox per actionable kind), and may be SUPERSEDED by a later
// decision in a subsequent meeting (status `superseded`). This module is the pure decider for each step;
// the M14-T05/T06 service + decision-emitter execute the returned effects inside the transaction.
//
// Authorization note: per-decision quorum BLOCKING (`quorate_decision` ABAC, `QUORUM_NOT_MET`) lands in
// M14-T05. Here we compute + stamp the snapshot the meeting may be held without quorum (§1.1) and surface
// the pure `decisionMeetsQuorum` predicate the ABAC layer wraps.
import type { IdgDecisionKind, IdgDecisionStatus, QuorumSnapshot } from "@wardenx/types";
import { IDG_REQUIRED_QUORUM } from "../policy";
import type { IdgSideEffect } from "./effects";
import { require_ } from "./errors";

/** §2.7 — `team_note` is recorded for the minutes only; every other kind emits `idg.decision_recorded` on
 * adjournment (§1.1 / §4.4). Adding a kind is a coordinated change with M7/M11/M12 (the §2.6 union is
 * exhaustive). */
export function isActionableDecisionKind(kind: IdgDecisionKind): boolean {
  return kind !== "team_note";
}

/**
 * Evaluate the §1.1 / D3 `IDG_REQUIRED_QUORUM` against the present attendees' disciplines. A quorum slot's
 * `role` is a single discipline or an `a|b` either-of expression; the slot is satisfied when at least
 * `count` distinct present disciplines match it. Pure — reads only the local platform-floor constant.
 * (Tenant-tightening — extra required slots — is layered by the M14-T05 quorum-evaluator service.)
 */
export function evaluateQuorum(presentDisciplines: readonly string[]): QuorumSnapshot {
  const present = [...new Set(presentDisciplines)];
  const presentSet = new Set(present);
  const missing: string[] = [];
  for (const slot of IDG_REQUIRED_QUORUM) {
    const options = slot.role.split("|");
    const satisfiers = options.filter((o) => presentSet.has(o)).length;
    if (satisfiers < slot.count) missing.push(slot.role);
  }
  return { met: missing.length === 0, presentDisciplines: present, missingDisciplines: missing };
}

/** The pure predicate the §4.7 `quorate_decision` ABAC wraps (M14-T05): does this snapshot satisfy quorum. */
export function decisionMeetsQuorum(snapshot: QuorumSnapshot): boolean {
  return snapshot.met;
}

/** The result of recording a decision (§2.7): the stamped quorum + the `open` genesis side-effect list. */
export interface DecisionRecordResult {
  readonly status: Extract<IdgDecisionStatus, "open">;
  readonly wasQuorate: boolean;
  readonly quorumSnapshot: QuorumSnapshot;
  readonly effects: ReadonlyArray<IdgSideEffect>;
}

/**
 * Record a decision while the meeting is `live` (§2.7). Genesis — there is no prior decision state. Guards:
 * the meeting must be `live` (`MEETING_NOT_LIVE`) and the patient must be on the meeting's caseload
 * (`INCLUSION_CRITERIA_FAILED`, URL-tamper defense, §2.3 D9). Stamps `was_quorate` + the quorum snapshot;
 * no outbox `idg.decision_recorded` yet — that bursts on adjournment. A non-quorate decision is still
 * recorded (the meeting may proceed) and flagged to the coordinator via the low-severity M36 notice.
 */
export function planDecisionRecord(input: {
  readonly meetingIsLive: boolean;
  readonly patientIncluded: boolean;
  readonly presentDisciplines: readonly string[];
}): DecisionRecordResult {
  require_(
    input.meetingIsLive,
    "MEETING_NOT_LIVE",
    "decisions may only be recorded while the meeting is live",
  );
  require_(
    input.patientIncluded,
    "INCLUSION_CRITERIA_FAILED",
    "the patient is not on this meeting's caseload",
  );
  const quorumSnapshot = evaluateQuorum(input.presentDisciplines);
  const wasQuorate = quorumSnapshot.met;
  const effects: IdgSideEffect[] = [
    { kind: "audit" },
    { kind: "outbox", event: "m14.decision.recorded_open" },
  ];
  if (!wasQuorate) effects.push({ kind: "alert", alert: "m14.decision.non_quorate" });
  return { status: "open", wasQuorate, quorumSnapshot, effects };
}

/**
 * Emit a decision at adjournment (§2.7): `open → emitted`. The adjournment emitter calls this for each
 * `status='open'` decision in the meeting (driven by the `emit_open_decisions` meeting effect). Only an
 * actionable kind publishes the `idg.decision_recorded` cross-module event (the M7/M11/M12/M16 contract,
 * §4.4); `team_note` flips to `emitted` for the minutes record with no downstream event. Throws
 * `DECISION_SUPERSEDED` / `DECISION_NOT_OPEN` if the decision is not `open`.
 */
export function planDecisionEmit(decision: {
  readonly status: IdgDecisionStatus;
  readonly kind: IdgDecisionKind;
}): ReadonlyArray<IdgSideEffect> {
  require_(
    decision.status !== "superseded",
    "DECISION_SUPERSEDED",
    "a superseded decision cannot be emitted",
  );
  require_(
    decision.status === "open",
    "DECISION_NOT_OPEN",
    "only an open decision may be emitted on adjournment",
  );
  const effects: IdgSideEffect[] = [
    { kind: "set_timestamp", field: "emitted_at" },
    { kind: "audit" },
  ];
  if (isActionableDecisionKind(decision.kind)) {
    effects.push({ kind: "outbox", event: "idg.decision_recorded" });
  }
  return effects;
}

/**
 * Supersede a prior decision (§2.8): a new `idg_decision` row in a subsequent meeting points back via
 * `superseded_by_decision_id`; the prior row flips `emitted → superseded` (it is never edited in place).
 * Throws `DECISION_SUPERSEDED` if the prior row is already superseded, `DECISION_NOT_OPEN` if it was never
 * committed (only an `emitted` decision may be superseded — an `open` one is corrected before adjournment).
 */
export function planDecisionSupersede(prior: {
  readonly status: IdgDecisionStatus;
}): ReadonlyArray<IdgSideEffect> {
  require_(
    prior.status !== "superseded",
    "DECISION_SUPERSEDED",
    "this decision is already superseded by another row",
  );
  require_(
    prior.status === "emitted",
    "DECISION_NOT_OPEN",
    "only an emitted decision may be superseded",
  );
  return [{ kind: "set_timestamp", field: "superseded_at" }, { kind: "audit" }];
}

/**
 * GAP-043 / §2.8 — edit an `open` decision. Once `emitted` a decision is immutable (it is corrected by a
 * supersede, never edited in place) and a `superseded` one is history. An `open` decision exists only in a
 * `live` meeting (adjournment emits every open one), so a non-live meeting is refused too.
 */
export function planDecisionUpdate(input: {
  readonly status: IdgDecisionStatus;
  readonly meetingIsLive: boolean;
}): void {
  require_(
    input.status !== "superseded",
    "DECISION_SUPERSEDED",
    "a superseded decision cannot be edited",
  );
  require_(
    input.status === "open",
    "DECISION_NOT_OPEN",
    "an emitted decision is immutable; supersede it in a later meeting instead",
  );
  require_(
    input.meetingIsLive,
    "MEETING_NOT_LIVE",
    "decisions may only be edited while the meeting is live",
  );
}

/** The result of superseding into a later meeting: the successor's stamped quorum + the effect list. */
export interface DecisionSupersedeIntoResult {
  readonly wasQuorate: boolean;
  readonly quorumSnapshot: QuorumSnapshot;
  readonly effects: ReadonlyArray<IdgSideEffect>;
}

/**
 * GAP-043 / §2.8 / §4.7 — supersede a prior `emitted` decision with a successor recorded in a SUBSEQUENT,
 * `live`, QUORATE meeting (`quorate_decision`). The quorum is evaluated from the target meeting's stored
 * present disciplines — never asserted by the caller and never copied from the prior row. Guard order:
 * prior status (409) → target live / caseload (422, via {@link planDecisionRecord}) → strictly later (422)
 * → quorum (422 `QUORUM_NOT_MET`).
 */
export function planDecisionSupersedeInto(input: {
  readonly priorStatus: IdgDecisionStatus;
  readonly priorMeetingStart: string;
  readonly target: {
    readonly isLive: boolean;
    readonly scheduledStart: string;
    readonly patientIncluded: boolean;
    readonly presentDisciplines: readonly string[];
  };
}): DecisionSupersedeIntoResult {
  const supersedeEffects = planDecisionSupersede({ status: input.priorStatus });
  const record = planDecisionRecord({
    meetingIsLive: input.target.isLive,
    patientIncluded: input.target.patientIncluded,
    presentDisciplines: input.target.presentDisciplines,
  });
  require_(
    Date.parse(input.target.scheduledStart) > Date.parse(input.priorMeetingStart),
    "SUPERSEDE_MEETING_NOT_SUBSEQUENT",
    "a decision may only be superseded in a subsequent meeting",
  );
  require_(
    decisionMeetsQuorum(record.quorumSnapshot),
    "QUORUM_NOT_MET",
    "the required IDG disciplines are not present at the superseding meeting",
  );
  return {
    wasQuorate: record.wasQuorate,
    quorumSnapshot: record.quorumSnapshot,
    effects: [...supersedeEffects, ...record.effects],
  };
}
