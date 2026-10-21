// apps/backend/src/modules/15-discipline-care-plans/volunteer/assignments.ts — M15-T04 (§2.2.5 / §7.4 / §7.5).
//
// The `volunteer_assignment` write decisions — the point where volunteer compliance stops being a report
// and becomes a precondition:
//
//   • `decideCreateVolunteerAssignment` (§7.4, route 17) refuses the INSERT with `VOLUNTEER_GATE_UNMET`
//     when ANY blocking 418.78 gate is unmet, and returns the failing kinds so the modal names them
//     instead of showing a generic denial. The §8.6 STRIDE override is honoured — a coordinator may book
//     past an unmet gate — but only with a documented reason ≥ 40 chars, and the decision then declares
//     the `gate_override` effect that writes the `m15.gate.override.invoked` audit event at `warn`.
//   • `decideInactivateAssignmentsForGate` (§7.5) is the expiry cascade: every OPEN assignment for the
//     volunteer is stamped `inactivated_at` + `inactivation_reason='gate_expired:<kind>'`, and one
//     `m15.volunteer.assignment_inactivated` event tells M17 to stop offering the volunteer.
//   • `decideReactivateAssignment` encodes the deliberate §7.5 asymmetry: renewal makes the volunteer
//     bookable again, but a previously-inactivated assignment is NEVER auto-reactivated — the coordinator
//     re-acknowledges, because the patient's situation may have moved on while the volunteer was out.
//
// PURE — the gate rows, the plan kind, and `now` are injected; the transaction is the caller's.
import { OVERRIDE_REASON_MIN_LENGTH } from "@chartwarden/discipline-plans";
import type {
  DisciplinePlanId,
  DisciplinePlanKind,
  IsoInstant,
  MembershipId,
  VolunteerAssignmentId,
  VolunteerGateKind,
} from "@chartwarden/types";
import type { DisciplinePlanSideEffect } from "../lifecycle/effects";
import { require_ } from "../lifecycle/errors";
import { effectiveStatusFor } from "./effective-status";
import type { VolunteerGateFacts } from "./gates";

/** What a `volunteer_assignment` INSERT is decided over (§2.2.5 / §7.4). */
export interface CreateVolunteerAssignmentFacts {
  readonly planId: DisciplinePlanId;
  /** The parent plan's kind — an assignment hangs off the `volunteer_plan` and nothing else (§2.2.5). */
  readonly planKind: DisciplinePlanKind;
  readonly volunteerMembershipId: MembershipId;
  readonly coordinatorMembershipId: MembershipId;
  /**
   * Every `volunteer_compliance_gate` row for this volunteer, or `null` when the store is unreadable —
   * which denies (§8.7), it does not pass.
   */
  readonly gates: ReadonlyArray<VolunteerGateFacts> | null;
  /** §8.6 — the documented bypass. Absent = no override attempted. */
  readonly override?: { readonly reason: string | null };
}

/** The decision a `volunteer_assignment` INSERT produces (§7.4). */
export interface CreateVolunteerAssignmentDecision {
  /** The gate kinds that were unmet — empty on the clean path, populated on an audited override. */
  readonly failingGates: ReadonlyArray<string>;
  readonly overridden: boolean;
  readonly effects: ReadonlyArray<DisciplinePlanSideEffect>;
}

/**
 * §7.4 / §8.6 — validate and decide the assignment INSERT. Raises `NOT_A_VOLUNTEER_PLAN` (422),
 * `VOLUNTEER_GATE_UNMET` (422) and `GATE_OVERRIDE_REASON_REQUIRED` (422). The override branch does not
 * weaken the gate: it records, at `warn`, that a named coordinator knowingly booked a non-compliant
 * volunteer, which is the artifact a survey asks for.
 */
export function decideCreateVolunteerAssignment(
  facts: CreateVolunteerAssignmentFacts,
  now: IsoInstant,
): CreateVolunteerAssignmentDecision {
  require_(
    facts.planKind === "volunteer_plan",
    "NOT_A_VOLUNTEER_PLAN",
    "a volunteer assignment may only be created on a volunteer plan",
  );

  const status = effectiveStatusFor(facts.volunteerMembershipId, facts.gates, now);
  if (status.isActive) {
    return { failingGates: [], overridden: false, effects: [{ kind: "audit" }] };
  }

  const reason = facts.override?.reason ?? null;
  require_(
    reason !== null,
    "VOLUNTEER_GATE_UNMET",
    `this volunteer has unmet 42 CFR 418.78 compliance gates: ${status.failingGates.join(", ")}`,
  );
  require_(
    (reason ?? "").trim().length >= OVERRIDE_REASON_MIN_LENGTH,
    "GATE_OVERRIDE_REASON_REQUIRED",
    `an override of an unmet volunteer compliance gate requires a documented reason of at least ${OVERRIDE_REASON_MIN_LENGTH} characters`,
  );
  return {
    failingGates: status.failingGates,
    overridden: true,
    effects: [
      { kind: "audit" },
      { kind: "gate_override", gateKinds: status.failingGates, reason: reason as string },
    ],
  };
}

/** An open `volunteer_assignment` the §7.5 cascade sweeps (§2.2.5). */
export interface OpenVolunteerAssignment {
  readonly assignmentId: VolunteerAssignmentId;
  readonly planId: DisciplinePlanId;
  readonly volunteerMembershipId: MembershipId;
  readonly inactivatedAt: IsoInstant | null;
}

/** One row the cascade stamps (§7.5). */
export interface AssignmentInactivation {
  readonly assignmentId: VolunteerAssignmentId;
  readonly planId: DisciplinePlanId;
  readonly inactivatedAt: IsoInstant;
  /** `gate_expired:<gate_kind>` — the §7.5 literal, parsed by the M36 alert copy and the UI badge. */
  readonly inactivationReason: string;
}

/** The full §7.5 cascade decision for one expired gate. */
export interface InactivationCascade {
  readonly volunteerMembershipId: MembershipId;
  readonly gateKind: VolunteerGateKind;
  readonly inactivations: ReadonlyArray<AssignmentInactivation>;
  /** The `m15.volunteer.gate_expired` payload's `openAssignmentsCount` (§2.4). */
  readonly openAssignmentsCount: number;
  /** The `m15.volunteer.assignment_inactivated` payload's `affectedPlanIds` (§2.4), de-duplicated. */
  readonly affectedPlanIds: ReadonlyArray<DisciplinePlanId>;
  readonly effects: ReadonlyArray<DisciplinePlanSideEffect>;
}

/** §7.5 — the `inactivation_reason` literal an expired gate stamps. */
export function gateExpiredReason(gateKind: VolunteerGateKind): string {
  return `gate_expired:${gateKind}`;
}

/**
 * §7.5 — decide the inactivation cascade an expired gate triggers. Only OPEN rows are touched (a row
 * already inactivated by an earlier gate keeps its original reason — the FIRST cause is the truthful one,
 * and re-stamping would rewrite why the volunteer came off the patient). Emitting nothing when no
 * assignment is open keeps the nightly run quiet rather than firing an event with an empty payload.
 */
export function decideInactivateAssignmentsForGate(args: {
  readonly volunteerMembershipId: MembershipId;
  readonly gateKind: VolunteerGateKind;
  readonly openAssignments: ReadonlyArray<OpenVolunteerAssignment>;
  readonly at: IsoInstant;
}): InactivationCascade {
  const open = args.openAssignments.filter(
    (a) => a.volunteerMembershipId === args.volunteerMembershipId && a.inactivatedAt === null,
  );
  const inactivations = open.map((a) => ({
    assignmentId: a.assignmentId,
    planId: a.planId,
    inactivatedAt: args.at,
    inactivationReason: gateExpiredReason(args.gateKind),
  }));
  const affectedPlanIds = [...new Set(inactivations.map((i) => i.planId))];
  return {
    volunteerMembershipId: args.volunteerMembershipId,
    gateKind: args.gateKind,
    inactivations,
    openAssignmentsCount: open.length,
    affectedPlanIds,
    effects:
      inactivations.length === 0
        ? []
        : [{ kind: "audit" }, { kind: "outbox", event: "m15.volunteer.assignment_inactivated" }],
  };
}

/**
 * §7.5 — the deliberate manual re-activation. Renewal alone does not bring the assignment back: the
 * coordinator re-acknowledges (which the route captures as a fresh `coordinator_acknowledged_at`) and the
 * volunteer must clear every gate at that moment, so a half-renewed volunteer cannot be waved back in.
 */
export function decideReactivateAssignment(args: {
  readonly assignment: OpenVolunteerAssignment;
  readonly gates: ReadonlyArray<VolunteerGateFacts> | null;
  readonly coordinatorAcknowledged: boolean;
  readonly now: IsoInstant;
}): { readonly effects: ReadonlyArray<DisciplinePlanSideEffect> } {
  require_(
    args.assignment.inactivatedAt !== null,
    "ASSIGNMENT_NOT_INACTIVE",
    "this volunteer assignment is already open",
  );
  const status = effectiveStatusFor(args.assignment.volunteerMembershipId, args.gates, args.now);
  require_(
    status.isActive,
    "VOLUNTEER_GATE_UNMET",
    `this volunteer still has unmet compliance gates: ${status.failingGates.join(", ")}`,
  );
  require_(
    args.coordinatorAcknowledged,
    "COORDINATOR_ACKNOWLEDGMENT_REQUIRED",
    "re-activating an assignment requires a fresh coordinator acknowledgment",
  );
  return { effects: [{ kind: "audit" }] };
}
