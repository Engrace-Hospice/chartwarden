// apps/backend/src/modules/20-field-safety/consumers/m17-visit-cadence.ts — M20-T04 (§4.8
// `m20.materialize-cadence.consumer`, §7.1, §2.2.1, D2).
//
// The three M17 lifecycle events that shape a visit's safety obligations, as pure deciders:
//
//   • `m17.visit.published`      → materialize the pre-visit / mid-visit / post-visit schedule (§7.1)
//   • `m17.visit.assigned`       → re-point the still-unanswered obligations at the new clinician (§2.2.1)
//   • `m17.visit.completed`      → retire the mid-visit prompts a short visit outran
//
// THE CADENCE ARITHMETIC IS §7.1's, TAKEN LITERALLY. "Scheduled 60 min × cadence 60 min → 1 mid-visit
// prompt at minute 60 of the visit" only yields ONE prompt if the endpoint is INCLUSIVE — minute 60 of a
// 60-minute visit is its final instant. So the prompts are at `start + k·cadence` for k ≥ 1 while that
// instant is ≤ the scheduled end, gated on the visit being at least `midVisitMinVisitDurationMinutes`
// long. An exclusive endpoint would give a 60-minute visit no mid-visit prompt at all and silently delete
// the D2 obligation from the single most common visit length on a hospice schedule.
//
// THE PRE-VISIT OBLIGATION IS ANCHORED BEFORE THE VISIT, NOT AT IT. §7.1: a 10:00 visit surfaces its card
// at 09:45 with `preVisitWindowMinutes = 15`. So `expected_at = scheduledStart − preVisitWindow` and the
// window runs forward to the scheduled start — the clinician is not late until the visit she is driving to
// has begun.
//
// M17 COMPLETION DOES NOT RE-ANCHOR THE POST-VISIT OBLIGATION; M18's CHECK-OUT DOES (see
// `./m18-evv-brackets`). §7.1 names the EVV event, and the two facts are not interchangeable: an EVV
// check-out is a device-captured statement about where the clinician physically was, while an M17
// completion can be a scheduler's back-office click the next morning. Re-anchoring on the later of the two
// would move a safety prompt to a moment the clinician was already home.
//
// A REASSIGNMENT NEVER REWRITES THE NAME ON AN OBLIGATION THAT ALREADY WENT UNANSWERED. Only `proposed`
// rows are re-pointed. An `overdue` or `escalated` row names a clinician who did not answer a safety
// prompt; moving that name to whoever picked the visit up afterwards would file one person's silence
// against another — and the supervisor reading the board would call the wrong phone.
import type { IsoInstant, MembershipId, SafetyPolicyEffectiveDto, SafetyPolicyVersionId } from "@wardenx/types";
import { withAudit } from "../lifecycle/effects";
import {
  type SafetyConsumerDecision,
  type SafetyScheduleMutation,
  type SafetySchedulePlanRow,
  type SafetyScheduleRowFacts,
  type SafetyScheduleSkip,
  type SafetyVisitAnchors,
  minutesBetween,
  shiftMinutes,
  windowMinutesForKind,
} from "./schedule-plan";

/** The instants the mid-visit prompts fall on for one visit, or `[]` when the visit is too short. */
export function midVisitCadencePoints(
  visit: Pick<SafetyVisitAnchors, "scheduledStartedAt" | "scheduledEndedAt">,
  policy: Pick<SafetyPolicyEffectiveDto, "midVisitCadenceMinutes" | "midVisitMinVisitDurationMinutes">,
): readonly IsoInstant[] {
  const durationMinutes = minutesBetween(visit.scheduledStartedAt, visit.scheduledEndedAt);
  if (durationMinutes < policy.midVisitMinVisitDurationMinutes) return [];
  // A non-positive cadence would loop forever; the D4 band forbids it, but a decider that trusts a band it
  // does not enforce is one migration away from an infinite loop in a cron.
  if (!(policy.midVisitCadenceMinutes > 0)) return [];

  const points: IsoInstant[] = [];
  for (let k = 1; k * policy.midVisitCadenceMinutes <= durationMinutes; k += 1) {
    points.push(shiftMinutes(visit.scheduledStartedAt, k * policy.midVisitCadenceMinutes));
  }
  return points;
}

/** Build one plan row for `kind` at `expectedAt`. */
function planRow(
  visit: SafetyVisitAnchors,
  policy: SafetyPolicyEffectiveDto,
  policyVersionId: SafetyPolicyVersionId,
  kind: SafetySchedulePlanRow["kind"],
  expectedAt: IsoInstant,
): SafetySchedulePlanRow {
  return {
    organizationId: visit.organizationId,
    providerEntityId: visit.providerEntityId,
    locationId: visit.locationId,
    visitId: visit.visitId,
    clinicianMembershipId: visit.clinicianMembershipId,
    kind,
    expectedAt,
    windowMinutes: windowMinutesForKind(kind, policy),
    safetyPolicyVersionId: policyVersionId,
  };
}

/**
 * §4.8 `m20.materialize-cadence.consumer` / §7.1 — the obligations one published visit owes.
 *
 * `existing` is the visit's current schedule rows, which makes the decider idempotent under redelivery:
 * `m17.visit.published` can arrive twice (an M17 republish after an edit is a normal event), and the
 * §3.3 `scis_visit_kind_expected_uniq` index would turn the second one into a driver-level unique
 * violation inside a worker retry loop rather than the no-op it should be.
 */
export function planVisitCadence(input: {
  readonly visit: SafetyVisitAnchors;
  readonly policy: SafetyPolicyEffectiveDto;
  readonly policyVersionId: SafetyPolicyVersionId;
  readonly existing: readonly SafetyScheduleRowFacts[];
}): SafetyConsumerDecision {
  const { visit, policy, policyVersionId } = input;
  const already = new Set(input.existing.map((row) => `${row.kind}@${Date.parse(row.expectedAt)}`));
  const mutations: SafetyScheduleMutation[] = [];
  const skipped: SafetyScheduleSkip[] = [];

  const propose = (kind: SafetySchedulePlanRow["kind"], expectedAt: IsoInstant): void => {
    if (already.has(`${kind}@${Date.parse(expectedAt)}`)) {
      skipped.push({ kind, reason: "already_materialized" });
      return;
    }
    mutations.push({ kind: "insert", row: planRow(visit, policy, policyVersionId, kind, expectedAt) });
  };

  propose("pre_visit", shiftMinutes(visit.scheduledStartedAt, -policy.preVisitWindowMinutes));

  const midPoints = midVisitCadencePoints(visit, policy);
  if (midPoints.length === 0) {
    skipped.push({
      kind: "mid_visit",
      reason:
        minutesBetween(visit.scheduledStartedAt, visit.scheduledEndedAt) <
        policy.midVisitMinVisitDurationMinutes
          ? "visit_shorter_than_mid_visit_minimum"
          : "no_cadence_point_inside_visit",
    });
  }
  for (const point of midPoints) propose("mid_visit", point);

  propose("post_visit", visit.scheduledEndedAt);

  return {
    mutations,
    // No §4.10 topic exists for "an obligation was made" and none is invented: the catalog is the twenty-two
    // of the v0.3 changelog, and nothing downstream acts on a materialization. The M4 write-audit trigger on
    // `safety_check_in_schedule` is what records it.
    effects: mutations.length === 0 ? [] : withAudit([]),
    skipped,
  };
}

/**
 * §2.2.1 — `m17.visit.assigned`: the visit changed hands. Re-point the obligations the new clinician now
 * owes; see the header on why an already-unanswered one keeps the old name.
 */
export function decideVisitReassigned(input: {
  readonly newClinicianMembershipId: MembershipId;
  readonly existing: readonly SafetyScheduleRowFacts[];
}): SafetyConsumerDecision {
  const mutations: SafetyScheduleMutation[] = input.existing
    .filter(
      (row) =>
        row.state === "proposed" && row.clinicianMembershipId !== input.newClinicianMembershipId,
    )
    .map((row) => ({
      kind: "repoint" as const,
      scheduleId: row.scheduleId,
      clinicianMembershipId: input.newClinicianMembershipId,
    }));

  return { mutations, effects: mutations.length === 0 ? [] : withAudit([]), skipped: [] };
}

/**
 * `m17.visit.completed` — retire the mid-visit prompts the visit outran.
 *
 * ONLY mid-visit, and only the ones still `proposed` and still in the future. The post-visit obligation is
 * the point of a completion (did she leave safely?) and survives; a pre-visit obligation that is still open
 * at completion is a real finding — the clinician entered a home without answering the safety prompt — and
 * retiring it would erase exactly the record D2 exists to keep.
 */
export function decideVisitCompleted(input: {
  readonly completedAt: IsoInstant;
  readonly existing: readonly SafetyScheduleRowFacts[];
}): SafetyConsumerDecision {
  const mutations: SafetyScheduleMutation[] = input.existing
    .filter(
      (row) =>
        row.kind === "mid_visit" &&
        row.state === "proposed" &&
        Date.parse(row.expectedAt) > Date.parse(input.completedAt),
    )
    .map((row) => ({
      kind: "retire" as const,
      scheduleId: row.scheduleId,
      reason: "visit_completed_early" as const,
    }));

  return { mutations, effects: mutations.length === 0 ? [] : withAudit([]), skipped: [] };
}
