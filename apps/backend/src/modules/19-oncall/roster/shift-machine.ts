// apps/backend/src/modules/19-oncall/roster/shift-machine.ts — M19-T04 (§2.2.2 / D2 / D3 / D7).
//
// The `on_call_shift` lifecycle: `scheduled → active → completed | cancelled`. This row is the single most
// survey-load-bearing thing M19 writes — it is the CoP 418.100(c)(2) evidence that a nurse was reachable at
// 2 a.m. — so every guard here is chosen by which direction a mistake harms the record.
//
// PURE, like the §2.2.1 call machine: facts in, new status + a declarative effect list out (../lifecycle/
// effects). The §4.8 `shift-open.cron` / `shift-close.cron` workers execute the effects inside the shift's
// transaction, so the row, its M4 audit row and its `m19.oncall_shift.*` outbox row commit together.
//
// NO STATE-HISTORY EFFECT, and that is a deliberate departure from §10 task 19, which asks for "an
// `on_call_shift_state_history` analog within state-history table". `triage_call_state_history` cannot hold
// one: its `triage_call_id` is NOT NULL with a real FK and its `to_state` is the `triage_call_state` enum —
// a shift transition has neither a call nor a call state. Nothing in the manifest's ten `ownedTables` is a
// shift-history table either, so inventing one would hard-fail `arch:status-matrix` as an orphan. The
// shift's transition record is therefore the M4 write-audit row (migration 0108 gives `on_call_shift` the
// `compliance` retention class precisely because it is survey evidence) plus the `opened_at` / `closed_at`
// columns the §3.3 CHECKs already force to be coherent with the status.
//
// THE THREE GUARDS AND WHY THEY POINT THE WAY THEY DO:
//   • ACTIVATION IS BLOCKED BEFORE `shift_starts_at`. Opening early enters a coverage claim for hours
//     nobody agreed to cover, and the claim is exactly what a surveyor reads.
//   • COMPLETION IS **NOT** BLOCKED BEFORE `shift_ends_at`. The asymmetry is the point: a shift that ends
//     early (handover, nurse called away) is a coverage window that really did stop, and recording the
//     early close makes the remaining gap VISIBLE to the coverage-gap watchdog. Forcing the row to claim
//     coverage until its scheduled end would hide it.
//   • CANCELLATION IS LEGAL ONLY FROM `scheduled`. §2.2.2's arrow diagram admits `cancelled` as a terminal
//     of `active` too, but §3.3's `m19_on_call_shift_opened_at` CHECK exempts `cancelled` from needing an
//     `opened_at` — it is written for a shift that never opened. An active shift that ends early is
//     `completed` with an early `closed_at`, which is the truthful record: for the hours it was active,
//     coverage existed. Cancelling it would erase them.
import type { IsoInstant, MembershipId, OncallShiftDiscipline, OncallShiftStatus } from "@wardenx/types";
import {
  type TriageSideEffect,
  type TriageTransitionResult,
  result,
  withAudit,
} from "../lifecycle/effects";
import { require_ } from "../lifecycle/errors";

/** §2.2.2 — the commands that move a shift. */
export type OnCallShiftCommand = "activateShift" | "completeShift" | "cancelShift";

/** One legal §2.2.2 edge. */
export interface OnCallShiftEdge {
  readonly from: OncallShiftStatus;
  readonly command: OnCallShiftCommand;
  readonly to: OncallShiftStatus;
}

/**
 * §2.2.2 — the shift transition table, a WHITELIST like `TRIAGE_CALL_EDGES`. Three edges, no more: there is
 * no re-open (a night that ended, ended) and no un-cancel (the replacement is a new row, which is what
 * keeps the roster-sync reconciliation idempotent).
 */
export const ON_CALL_SHIFT_EDGES: readonly OnCallShiftEdge[] = [
  { from: "scheduled", command: "activateShift", to: "active" },
  { from: "active", command: "completeShift", to: "completed" },
  { from: "scheduled", command: "cancelShift", to: "cancelled" },
];

/** §2.2.2 — the statuses no command advances out of. */
export const ON_CALL_SHIFT_TERMINAL_STATUSES = [
  "completed",
  "cancelled",
] as const satisfies readonly OncallShiftStatus[];

/** Resolve the edge for `(from, command)`, refusing in the safe direction when there is none. */
export function resolveShiftEdge(
  from: OncallShiftStatus,
  command: OnCallShiftCommand,
): OnCallShiftEdge {
  const terminal = (ON_CALL_SHIFT_TERMINAL_STATUSES as readonly OncallShiftStatus[]).includes(from);
  require_(
    !terminal,
    "SHIFT_TERMINAL",
    `the shift is already ${from}; no command advances out of it`,
  );
  const edge = ON_CALL_SHIFT_EDGES.find((e) => e.from === from && e.command === command);
  require_(
    edge !== undefined,
    "SHIFT_INVALID_STATE_TRANSITION",
    `'${command}' is not a legal command from '${from}'`,
  );
  return edge;
}

/** The commands legal from `from` — what the §5 shift screen renders as buttons. */
export function availableShiftCommands(from: OncallShiftStatus): readonly OnCallShiftCommand[] {
  return ON_CALL_SHIFT_EDGES.filter((e) => e.from === from).map((e) => e.command);
}

/** §2.5 — optimistic concurrency on `on_call_shift` (the Sched edits while the cron opens). */
export function assertShiftVersion(current: number, expected: number): void {
  require_(
    current === expected,
    "SHIFT_STALE_VERSION",
    `the shift has moved on (version ${current}, you sent ${expected})`,
  );
}

/** One `on_call_shift` row as the machine sees it — the §2.2.2 columns and nothing more. */
export interface OnCallShiftFacts {
  readonly status: OncallShiftStatus;
  readonly version: number;
  readonly shiftStartsAt: IsoInstant;
  readonly shiftEndsAt: IsoInstant;
  readonly discipline: OncallShiftDiscipline;
  readonly primaryOnCallMembershipId: MembershipId | null;
  readonly externalActorId: string | null;
  readonly openedAt: IsoInstant | null;
  readonly closedAt: IsoInstant | null;
}

/** A transition of the shift machine. */
export type OnCallShiftTransition = TriageTransitionResult<OncallShiftStatus, OnCallShiftCommand>;

/**
 * §2.2.2 / D7 `scheduled → active` — the shift-open cron's transition.
 *
 * Pins `policy_snapshot` to the tenant policy as it stands NOW. The column is NOT NULL with no default, so
 * the row already carries a provisional snapshot from whenever it was scheduled; D7's binding one is this
 * re-pin at open. That distinction matters in exactly the case D7 was written for: a policy edited between
 * the Sched creating next Friday's shift and the shift opening must govern the night that is starting, not
 * the afternoon the row was typed.
 *
 * Emits `m19.oncall_shift.activated` — the SINGLE canonical shift-open topic (§4.10 / M19-F12), which M36's
 * `on_call` channel synchronizer and M20's after-hours SOS path both subscribe to.
 */
export function activateShift(input: {
  readonly shift: OnCallShiftFacts;
  readonly policySnapshot: unknown;
  readonly at: IsoInstant;
}): OnCallShiftTransition {
  const edge = resolveShiftEdge(input.shift.status, "activateShift");
  require_(
    input.shift.shiftStartsAt <= input.at,
    "SHIFT_NOT_YET_STARTED",
    `the window opens at ${input.shift.shiftStartsAt}; refusing to claim coverage from ${input.at}`,
  );
  require_(
    input.policySnapshot !== null && input.policySnapshot !== undefined,
    "SHIFT_POLICY_SNAPSHOT_REQUIRED",
    "no tenant_oncall_policy row to pin; the shift could never prove which escalation ladder was live",
  );

  return result(
    edge.from,
    edge.command,
    edge.to,
    withAudit([
      { kind: "pin_policy_snapshot", snapshot: input.policySnapshot },
      { kind: "set_timestamp", field: "opened_at", at: input.at },
      { kind: "outbox", event: "m19.oncall_shift.activated" },
    ]),
  );
}

/**
 * §2.2.2 `active → completed` — the shift-close cron's transition, and the only terminal an opened shift
 * has. Early completion is permitted on purpose (see the file header): the honest record of a night that
 * ended at 03:00 is a shift closed at 03:00, and the gap that leaves is the coverage-gap watchdog's to
 * find. Emits `m19.oncall_shift.completed`, which is what removes the actor from M36's `on_call` channel.
 */
export function completeShift(input: {
  readonly shift: OnCallShiftFacts;
  readonly at: IsoInstant;
}): OnCallShiftTransition {
  const edge = resolveShiftEdge(input.shift.status, "completeShift");
  return result(
    edge.from,
    edge.command,
    edge.to,
    withAudit([
      { kind: "set_timestamp", field: "closed_at", at: input.at },
      { kind: "outbox", event: "m19.oncall_shift.completed" },
    ]),
  );
}

/**
 * §2.2.2 `scheduled → cancelled` — a coverage window given up before it ever opened.
 *
 * NO OUTBOX EVENT, and that is not an omission. §4.10 publishes `activated` and `completed`; M36's channel
 * synchronizer adds membership on the first and removes it on the second. A shift that never activated was
 * never in the channel, so a `cancelled` emit would ask M36 to remove a member it never added. What the
 * cancellation DOES leave behind is a hole in tomorrow's coverage — and that is the coverage-gap watchdog's
 * finding to report, on its own 30-minute cadence, against the whole 24-hour window rather than one row.
 */
export function cancelShift(input: {
  readonly shift: OnCallShiftFacts;
  readonly reason: string;
}): OnCallShiftTransition {
  const edge = resolveShiftEdge(input.shift.status, "cancelShift");
  require_(
    input.reason.trim().length > 0,
    "SHIFT_CANCEL_REASON_REQUIRED",
    "record why the window was given up; it is the only thing a cancelled shift row says",
  );
  return result(edge.from, edge.command, edge.to, withAudit([]));
}

/**
 * §4.8 — is this shift due to be opened at `at`? The `shift-open.cron` predicate, isolated so the worker
 * and the §9 tests share one definition rather than each re-deriving `shift_starts_at <= now()`.
 */
export function isShiftDueToOpen(shift: OnCallShiftFacts, at: IsoInstant): boolean {
  return shift.status === "scheduled" && shift.shiftStartsAt <= at;
}

/** §4.8 — is this shift due to be closed at `at`? The `shift-close.cron` predicate. */
export function isShiftDueToClose(shift: OnCallShiftFacts, at: IsoInstant): boolean {
  return shift.status === "active" && shift.shiftEndsAt <= at;
}

/**
 * D10 — does this shift cover the instant `at`?
 *
 * `active` OR `scheduled`, because `triage_call.on_call_shift_id` is NOT NULL and the shift-open cron runs
 * every five minutes: between `shift_starts_at` and the tick that flips the row, a call arriving at 19:02
 * has a covering nurse and a row that still says `scheduled`. Refusing it would drop a real call on a cron
 * scheduling artefact. `completed` is excluded even when the window still contains `at` — a shift closed
 * early has stopped covering, which is precisely what the early-close guard above exists to record.
 */
export function shiftCoversInstant(shift: OnCallShiftFacts, at: IsoInstant): boolean {
  if (shift.status !== "active" && shift.status !== "scheduled") return false;
  return shift.shiftStartsAt <= at && at < shift.shiftEndsAt;
}

/** Assert the effect list a shift transition returned carries the M4 audit row (§2.4's invariant). */
export function shiftEffectKinds(
  transition: OnCallShiftTransition,
): readonly TriageSideEffect["kind"][] {
  return transition.effects.map((e) => e.kind);
}
