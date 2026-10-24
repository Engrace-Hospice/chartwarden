// apps/backend/src/modules/20-field-safety/consumers/m18-evv-brackets.ts — M20-T04 (§4.8
// `m20.evv-check-in.consumer` / `m20.evv-check-out.consumer`, §7.1).
//
// M18's two bracket events are what turn a plan made at publish into obligations measured from where the
// clinician actually was.
//
// THE MID-VISIT CADENCE IS MEASURED FROM THE ARRIVAL, NOT FROM THE SCHEDULE. §7.1 is explicit and its
// arithmetic only closes one way: the 10:00 visit is entered at 10:02 and the mid-visit prompt surfaces at
// 11:02 — sixty minutes after the ARRIVAL, not after the scheduled start. Anchoring to the schedule would
// prompt a clinician who arrived forty minutes late at minute twenty of her visit and then leave her
// unprompted for the rest of it: the cadence exists to interrupt time spent IN the home.
//
// THE EVV CHECK-IN DOES NOT CLOSE AN UNANSWERED PRE-VISIT OBLIGATION, AND THE SCHEMA IS WHY. §7.1 says
// the consumer "closes the pre-visit window", and in its own worked sequence that is a no-op because Sarah
// already posted the check-in. When she has NOT, there is no truthful way to close it: the
// `m20_scis_recorded_fulfilled` CHECK refuses `state='recorded'` without a fulfilling `safety_check_in`
// row, and minting that row on her behalf would forge an attestation — M20 would be recording that a
// clinician said "I'm OK" when nobody asked her. So the obligation stands and the D4 ladder keeps running.
// That is the right answer as well as the only representable one: D2 asks "are you OK", not "are you
// there", and an unanswered safety prompt from a clinician who has just walked into a house is precisely
// the event the module exists for. The supervisor the ladder reaches sees the EVV arrival on the same
// board row (`lastKnownLocation`), so the judgement takes one glance.
//
// THE POST-VISIT OBLIGATION IS RE-ANCHORED HERE AND NOWHERE ELSE (see `./m17-visit-cadence`): publish
// anchors it to the scheduled end so that a visit with no check-out ever still owes one — the fail-safe —
// and this consumer moves it to the moment the clinician's device says she left.
import type {
  IsoInstant,
  SafetyPolicyEffectiveDto,
  SafetyPolicyVersionId,
} from "@chartwarden/types";
import { withAudit } from "../lifecycle/effects";
import {
  type SafetyConsumerDecision,
  type SafetyScheduleMutation,
  type SafetyScheduleRowFacts,
  type SafetyVisitAnchors,
  minutesBetween,
  shiftMinutes,
  windowMinutesForKind,
} from "./schedule-plan";

/**
 * §4.8 `m20.evv-check-in.consumer` — `m18.evv.check_in_recorded`.
 *
 * Only `proposed` mid-visit rows move. One that has already gone `overdue` is a prompt the clinician did
 * not answer; sliding it forward would retro-actively make her on time.
 */
export function decideEvvCheckIn(input: {
  readonly visit: Pick<SafetyVisitAnchors, "scheduledStartedAt">;
  readonly checkedInAt: IsoInstant;
  readonly existing: readonly SafetyScheduleRowFacts[];
}): SafetyConsumerDecision {
  const shift = minutesBetween(input.visit.scheduledStartedAt, input.checkedInAt);
  const mutations: SafetyScheduleMutation[] =
    shift === 0
      ? []
      : input.existing
          .filter((row) => row.kind === "mid_visit" && row.state === "proposed")
          .map((row) => ({
            kind: "reanchor" as const,
            scheduleId: row.scheduleId,
            expectedAt: shiftMinutes(row.expectedAt, shift),
            windowMinutes: row.windowMinutes,
          }));

  return { mutations, effects: mutations.length === 0 ? [] : withAudit([]), skipped: [] };
}

/**
 * §4.8 `m20.evv-check-out.consumer` / §7.1 — `m18.evv.check_out_recorded` opens the post-visit window.
 *
 * Three acts, in this order: re-anchor the post-visit obligation to the check-out (or MATERIALIZE it if the
 * visit predates M20's cadence materializer — a tenant that enables field safety mid-week has visits
 * already published, and the one obligation that must not be missing is the one that asks whether she got
 * out safely); retire the mid-visit prompts the visit outran; emit nothing (no §4.10 topic describes a
 * window opening, and nothing downstream acts on it).
 */
export function decideEvvCheckOut(input: {
  readonly visit: SafetyVisitAnchors;
  readonly checkedOutAt: IsoInstant;
  readonly policy: SafetyPolicyEffectiveDto;
  readonly policyVersionId: SafetyPolicyVersionId;
  readonly existing: readonly SafetyScheduleRowFacts[];
}): SafetyConsumerDecision {
  const mutations: SafetyScheduleMutation[] = [];
  const windowMinutes = windowMinutesForKind("post_visit", input.policy);

  const postVisit = input.existing.find(
    (row) => row.kind === "post_visit" && row.state === "proposed",
  );
  if (postVisit === undefined) {
    // No open post-visit obligation. Either it was already answered (nothing to do) or it never existed.
    const answered = input.existing.some((row) => row.kind === "post_visit");
    if (!answered) {
      mutations.push({
        kind: "insert",
        row: {
          organizationId: input.visit.organizationId,
          providerEntityId: input.visit.providerEntityId,
          locationId: input.visit.locationId,
          visitId: input.visit.visitId,
          clinicianMembershipId: input.visit.clinicianMembershipId,
          kind: "post_visit",
          expectedAt: input.checkedOutAt,
          windowMinutes,
          safetyPolicyVersionId: input.policyVersionId,
        },
      });
    }
  } else if (postVisit.expectedAt !== input.checkedOutAt) {
    mutations.push({
      kind: "reanchor",
      scheduleId: postVisit.scheduleId,
      expectedAt: input.checkedOutAt,
      windowMinutes,
    });
  }

  for (const row of input.existing) {
    if (row.kind !== "mid_visit" || row.state !== "proposed") continue;
    if (Date.parse(row.expectedAt) <= Date.parse(input.checkedOutAt)) continue;
    mutations.push({
      kind: "retire",
      scheduleId: row.scheduleId,
      reason: "visit_completed_early",
    });
  }

  return { mutations, effects: mutations.length === 0 ? [] : withAudit([]), skipped: [] };
}
