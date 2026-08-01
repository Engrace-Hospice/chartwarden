// apps/backend/src/modules/20-field-safety/consumers/schedule-plan.ts — M20-T04 (§2.2.1, §4.8, §7.1).
//
// The vocabulary the four M17/M18 consumers share: the narrowed visit a `safety_check_in_schedule` row is
// anchored to, the row a materializer proposes, and the TARGETED mutation a consumer decides on an
// existing row.
//
// A MUTATION CARRIES ITS TARGET; A SIDE EFFECT DOES NOT. `../lifecycle/effects` models one aggregate's own
// transition — `set_schedule_state` means "the schedule this decision is about". A consumer, by contrast,
// acts on a SET of rows belonging to one visit and has to say which row each act lands on, so the acts are
// a separate type with a `scheduleId` on every member. The two compose: a consumer decision carries
// `mutations` (the row writes) and `effects` (the M4 audit row, the §4.10 outbox event, the §4.9 alert),
// and the M20-T06 runner executes both inside the visit's transaction.
//
// THE FULFILMENT WINDOW IS PER KIND, AND ONE OF THE THREE HAS NO KNOB. §2.2.4 gives
// `preVisitWindowMinutes` and `postVisitWindowMinutes` and NOTHING for mid-visit; §7.3's worked sequence
// nonetheless states "`expected_at + windowMinutes (5)`" for a mid-visit prompt, and 5 is simultaneously
// the floor value of `postVisitWindowMinutes` and of `gentleReminderMinutes`. {@link windowMinutesForKind}
// resolves the tie to `gentleReminderMinutes`, because that is the knob whose MEANING matches: the window
// is the pre-alert nudge period, and tying its close to the first D4 rung means the row flips to `overdue`
// exactly when the ladder starts — no dead band in which the detector computes a rung it cannot act on.
// A tenant that tightens the gentle reminder to 2 minutes tightens the mid-visit window with it, which is
// the correct direction; borrowing the post-visit knob would have coupled it to an unrelated screen.
//
// A CONSEQUENCE WORTH STATING: when a kind's window EXCEEDS `gentleReminderMinutes` — the ordinary
// pre-visit case, 15 vs 5 — the row is still `proposed` when the gentle rung passes, so the detector's
// first act on it is the SUPERVISOR rung. The first alert is therefore louder than the ladder's bottom
// step, never quieter. That is the fail-safe direction, and `field-safety-consumers.test.ts` pins it so
// nobody "fixes" it into silence.
import type {
  IsoInstant,
  LocationId,
  MembershipId,
  OrgId,
  PatientId,
  ProviderEntityId,
  SafetyCheckInKind,
  SafetyCheckInScheduleId,
  SafetyCheckInState,
  SafetyPolicyEffectiveDto,
  SafetyPolicyVersionId,
  VisitId,
} from "@wardenx/types";
import type { SafetySideEffect } from "../lifecycle/effects";

/** The three visit-bracketing kinds — the only ones a visit consumer ever materializes. §3.3's
 *  `m20_scis_visit_kind` CHECK is the same set from the other side (these REQUIRE a `visit_id`). */
export const SAFETY_VISIT_BRACKET_KINDS = ["pre_visit", "mid_visit", "post_visit"] as const;

/** One of the three visit-bracketing check-in kinds. */
export type SafetyVisitBracketKind = (typeof SAFETY_VISIT_BRACKET_KINDS)[number];

/**
 * M17's `VisitDto` narrowed to what a safety schedule needs.
 *
 * The narrowing is the point: `VisitDto` carries the patient, the admission, the EVV bracket state and the
 * encounter id, none of which belongs in a workforce-safety row. Reading the visit back through the seam
 * and projecting HERE keeps the wide DTO out of the deciders, which is what lets them stay pure and lets a
 * reviewer see at a glance that no clinical field reached this module.
 */
export interface SafetyVisitAnchors {
  readonly visitId: VisitId;
  readonly organizationId: OrgId;
  readonly providerEntityId: ProviderEntityId;
  readonly locationId: LocationId;
  readonly clinicianMembershipId: MembershipId;
  /** Used ONLY to resolve the board's minimum-necessary first name (§4.4); never stored on an M20 row. */
  readonly patientId: PatientId;
  readonly scheduledStartedAt: IsoInstant;
  readonly scheduledEndedAt: IsoInstant;
}

/** A `safety_check_in_schedule` row a consumer proposes to INSERT. Every NOT NULL column of §3.3 is here;
 *  `state` is the column default (`proposed`) and is not restated. */
export interface SafetySchedulePlanRow {
  readonly organizationId: OrgId;
  readonly providerEntityId: ProviderEntityId;
  readonly locationId: LocationId;
  readonly visitId: VisitId;
  readonly clinicianMembershipId: MembershipId;
  readonly kind: SafetyVisitBracketKind;
  readonly expectedAt: IsoInstant;
  readonly windowMinutes: number;
  /** §2.2.4 — the policy version whose thresholds this obligation was made under, pinned at materialization
   *  so a 2031 replay reads the 2026 cadence rather than today's. */
  readonly safetyPolicyVersionId: SafetyPolicyVersionId;
}

/** An existing `safety_check_in_schedule` row as a visit consumer sees it. */
export interface SafetyScheduleRowFacts {
  readonly scheduleId: SafetyCheckInScheduleId;
  readonly kind: SafetyCheckInKind;
  readonly state: SafetyCheckInState;
  readonly expectedAt: IsoInstant;
  readonly windowMinutes: number;
  readonly clinicianMembershipId: MembershipId;
}

/** Why an obligation was retired. Closed union: a retired safety obligation is an M4-audited DELETE, and
 *  "the row is gone" is only defensible if the trail says which upstream fact removed it. */
export type SafetyScheduleRetireReason =
  | "visit_no_show"
  | "visit_completed_early"
  | "reassigned_away";

/** One targeted write on a `safety_check_in_schedule` row (or one new row). */
export type SafetyScheduleMutation =
  /** Materialize a new obligation. */
  | { readonly kind: "insert"; readonly row: SafetySchedulePlanRow }
  /**
   * Move an obligation's `expected_at` (and its window) — the EVV re-anchor. The row keeps its identity,
   * so a supervisor watching the board sees the prompt move rather than one obligation vanish and another
   * appear.
   */
  | {
      readonly kind: "reanchor";
      readonly scheduleId: SafetyCheckInScheduleId;
      readonly expectedAt: IsoInstant;
      readonly windowMinutes: number;
    }
  /** §2.2.1 — point an obligation at the clinician M17 reassigned the visit to. */
  | {
      readonly kind: "repoint";
      readonly scheduleId: SafetyCheckInScheduleId;
      readonly clinicianMembershipId: MembershipId;
    }
  /**
   * DELETE an obligation that can no longer be met.
   *
   * There is no `void` / `cancelled` member of `safety_check_in_state` (§3.2 gives six: `proposed`,
   * `recorded`, `overdue`, `escalated`, `superseded`, `incident_opened`), and the two that could be
   * repurposed both lie: `recorded` is refused by the `m20_scis_recorded_fulfilled` CHECK without a
   * fulfilling check-in row, and `superseded` means correction-of-record. So the only truthful
   * representation of "this plan was invalidated" is the row's absence — and the DELETE is captured by the
   * M4 write-audit trigger, which is what keeps the retirement on the record.
   */
  | {
      readonly kind: "retire";
      readonly scheduleId: SafetyCheckInScheduleId;
      readonly reason: SafetyScheduleRetireReason;
    }
  /** Flip an obligation to `overdue` NOW, ahead of the detector (§4.8's no-show inquiry). */
  | {
      readonly kind: "mark_overdue";
      readonly scheduleId: SafetyCheckInScheduleId;
      readonly overdueDetectedAt: IsoInstant;
    };

/** What one upstream event decides: the row writes, and the emissions that accompany them. */
export interface SafetyConsumerDecision {
  readonly mutations: readonly SafetyScheduleMutation[];
  readonly effects: readonly SafetySideEffect[];
  /** Why a materializer produced nothing for a kind — surfaced so "no mid-visit prompt" is explainable on
   *  the §5 screens without re-deriving the policy arithmetic. */
  readonly skipped: readonly SafetyScheduleSkip[];
}

/** One obligation a materializer deliberately did NOT create. */
export interface SafetyScheduleSkip {
  readonly kind: SafetyVisitBracketKind;
  readonly reason:
    | "visit_shorter_than_mid_visit_minimum"
    | "no_cadence_point_inside_visit"
    | "already_materialized";
}

/** The fulfilment window for a bracketing kind — see the header on why mid-visit borrows the gentle rung. */
export function windowMinutesForKind(
  kind: SafetyVisitBracketKind,
  policy: Pick<
    SafetyPolicyEffectiveDto,
    "preVisitWindowMinutes" | "postVisitWindowMinutes" | "gentleReminderMinutes"
  >,
): number {
  switch (kind) {
    case "pre_visit":
      return policy.preVisitWindowMinutes;
    case "post_visit":
      return policy.postVisitWindowMinutes;
    case "mid_visit":
      return policy.gentleReminderMinutes;
  }
}

/** Minutes between two instants (`to − from`). */
export function minutesBetween(fromIso: IsoInstant, toIso: IsoInstant): number {
  return (Date.parse(toIso) - Date.parse(fromIso)) / 60_000;
}

/** `atIso` shifted by `minutes` (negative shifts backwards). */
export function shiftMinutes(atIso: IsoInstant, minutes: number): IsoInstant {
  return new Date(Date.parse(atIso) + minutes * 60_000).toISOString();
}

/** The states an obligation can still be moved or retired from — a `recorded` row is history and an
 *  `incident_opened` one is a supervisor's act; neither is a consumer's to rewrite. */
export function isOpenObligation(state: SafetyCheckInState): boolean {
  return state === "proposed" || state === "overdue" || state === "escalated";
}
