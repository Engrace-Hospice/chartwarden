// @wardenx/idg — §2.2 IDG meeting lifecycle state machine (M14-T03). Pure, IO-free.
//
// The meeting aggregate lifecycle (§2.2):
//
//   scheduled ─BUILD_PACKETS→ packets_building ─PACKETS_READY→ packets_ready ─START→ live ─ADJOURN→ adjourned
//      │                          └BUILD_FAILED→ scheduled (retry)                              (step-up — D13)
//      ├CANCEL→ cancelled        packets_ready ─CANCEL→ cancelled
//      └RESCHEDULE→ rescheduled  packets_ready ─RESCHEDULE→ rescheduled
//   (CANCEL / RESCHEDULE from scheduled|packets_ready are guarded by perPatientReviewFloorClear — D2)
//
// Pure transition function (the M8/M11/M13 convention): it validates the event is legal from the current
// state (the §2.2 graph — nothing transitions on a string match), runs the enumerated guards (failures
// raise the precise §4.3 code via IdgStateError), and returns the new state + the §2.7 in-transaction
// side-effect list the service executes. No IO; every fact a guard needs (step-up freshness, per-patient
// review-floor clearance, override authority, transition reason) is resolved upstream and passed in.
import type { IdgMeetingStatus } from "@wardenx/types";
import { type IdgSideEffect, type IdgTransitionResult, result } from "./effects";
import { IdgStateError, require_ } from "./errors";

export type MeetingState = IdgMeetingStatus;

/** A `{patientId, floorAt}` pair captured when a CANCEL/RESCHEDULE override breaches a per-patient floor. */
export interface ReviewFloorBreach {
  readonly patientId: string;
  readonly floorAt: string;
}

/** The §2.2 meeting lifecycle events. Per-event facts are resolved upstream and injected as data. */
export type MeetingEvent =
  | {
      readonly type: "BUILD_PACKETS";
      /** §2.3 D9 — the count of patients in the included set the build jobs are enqueued for. */
      readonly includedPatientCount: number;
    }
  | { readonly type: "PACKETS_READY"; readonly builtPacketCount: number }
  | { readonly type: "BUILD_FAILED" }
  | { readonly type: "START" }
  | {
      readonly type: "ADJOURN";
      /** §2.2 D13 — a step-up auth completed within the freshness window (`ADJOURN_STEP_UP_FRESHNESS_MINUTES`). */
      readonly stepUpFresh: boolean;
    }
  | ({ readonly type: "CANCEL"; readonly reason: string } & ReviewFloorGuardFacts)
  | ({ readonly type: "RESCHEDULE"; readonly reason: string } & ReviewFloorGuardFacts);

/** The M14-F01 / ADR-0018 D2 review-floor guard facts shared by CANCEL + RESCHEDULE. */
interface ReviewFloorGuardFacts {
  /** Computed upstream: every included patient is covered by another review on/before their floor
   * (for RESCHEDULE this is evaluated against the NEW `scheduled_start`). */
  readonly reviewFloorClear: boolean;
  /** The caller holds `idg.override_review_floor` AND completed step-up (route-resolved); only consulted
   * when `reviewFloorClear` is false. */
  readonly overrideAuthorized: boolean;
  /** The breaching `{patientId, floorAt}` set recorded on the override audit event (when overriding). */
  readonly breachingPatients?: ReadonlyArray<ReviewFloorBreach>;
}

export type MeetingTransition = IdgTransitionResult<MeetingState, MeetingEvent["type"]>;

/** The legal §2.2 transition graph (from → events accepted). Guards are checked separately. */
export const MEETING_GRAPH: Readonly<Record<MeetingState, ReadonlyArray<MeetingEvent["type"]>>> = {
  scheduled: ["BUILD_PACKETS", "CANCEL", "RESCHEDULE"],
  packets_building: ["PACKETS_READY", "BUILD_FAILED"],
  packets_ready: ["START", "CANCEL", "RESCHEDULE"],
  live: ["ADJOURN"],
  adjourned: [],
  cancelled: [],
  rescheduled: [],
};

/** The shared CANCEL / RESCHEDULE per-patient review-floor guard (M14-F01 / ADR-0018 D2). Refuses the
 * transition with `PER_PATIENT_REVIEW_FLOOR_BREACH` unless either the floor is clear or an audited override
 * is authorized; on override it appends the `m14.review_floor.override_recorded` outbox + Compliance alert. */
function reviewFloorEffects(reason: string, facts: ReviewFloorGuardFacts): IdgSideEffect[] {
  require_(
    reason.trim().length > 0,
    "MEETING_TRANSITION_REASON_REQUIRED",
    "a cancellation/reschedule reason is required",
  );
  if (!facts.reviewFloorClear) {
    require_(
      facts.overrideAuthorized,
      "PER_PATIENT_REVIEW_FLOOR_BREACH",
      "this transition would push an included patient past their per-patient 15-day review floor with no covering meeting",
    );
    return [
      { kind: "audit" },
      { kind: "outbox", event: "m14.review_floor.override_recorded" },
      { kind: "alert", alert: "m14.review_floor.override_recorded" },
    ];
  }
  return [{ kind: "audit" }];
}

/**
 * The genesis of a meeting: a `scheduled` row (§2.2 / §2.7 — placeholder insert by the schedule worker or a
 * coordinator). There is no prior state, so this is a factory, not a transition. Returns the §2.8
 * side-effect list the service runs in the create transaction (audit + the `m14.meeting.scheduled` outbox).
 */
export function planMeetingScheduled(): ReadonlyArray<IdgSideEffect> {
  return [{ kind: "audit" }, { kind: "outbox", event: "m14.meeting.scheduled" }];
}

/**
 * Apply a meeting lifecycle event (§2.2). Throws {@link IdgStateError} `ILLEGAL_MEETING_TRANSITION` if the
 * event is not accepted from `from`, or the specific §4.3 guard code on a guard failure. Returns the new
 * state + the ordered §2.7 side-effect list the service runs in the meeting's optimistic-locked tx.
 */
export function transitionMeeting(from: MeetingState, event: MeetingEvent): MeetingTransition {
  if (!MEETING_GRAPH[from].includes(event.type)) {
    throw new IdgStateError(
      "ILLEGAL_MEETING_TRANSITION",
      `meeting cannot ${event.type} from '${from}'`,
    );
  }

  switch (event.type) {
    case "BUILD_PACKETS":
      // §2.7 — enqueue one packet build job per included patient (idempotency `(meeting_id, patient_id)`).
      return result(from, event.type, "packets_building", [
        { kind: "enqueue_packet_builds" },
        { kind: "audit" },
        { kind: "outbox", event: "m14.packets.build_started" },
      ]);

    case "PACKETS_READY":
      // §2.7 — packets frozen-ready pre-meeting; T-24h reminder fanout to assigned attendees via M36.
      return result(from, event.type, "packets_ready", [
        { kind: "audit" },
        { kind: "outbox", event: "m14.packets.ready" },
        { kind: "alert", alert: "m14.packets.ready" },
      ]);

    case "BUILD_FAILED":
      // §2.2 — returns to `scheduled`; the build worker retries (no downstream event at machine level).
      return result(from, event.type, "scheduled", [{ kind: "audit" }]);

    case "START":
      // §2.7 — opens the decision/action-item write path; per-patient timer starts.
      return result(from, event.type, "live", [
        { kind: "audit" },
        { kind: "outbox", event: "m14.meeting.started" },
      ]);

    case "ADJOURN": {
      // §2.2 D13 — step-up gate is the precondition; without it the route redirects to the M2 step-up flow.
      require_(
        event.stepUpFresh,
        "STEP_UP_REQUIRED",
        "a fresh step-up auth is required to adjourn a meeting",
      );
      // §2.7 — the commit point: freeze packets, stamp the per-patient review floor, burst the open-decision
      // outbox events, lock action items, finalize the minutes, and emit the adjournment/minutes/freeze events.
      return result(from, event.type, "adjourned", [
        { kind: "freeze_packets" },
        { kind: "stamp_review_floor" },
        { kind: "emit_open_decisions" },
        { kind: "assign_action_items" },
        { kind: "finalize_minutes" },
        { kind: "set_timestamp", field: "adjourned_at" },
        { kind: "audit" },
        { kind: "outbox", event: "idg.decision_recorded" },
        { kind: "outbox", event: "m14.meeting.adjourned" },
        { kind: "outbox", event: "m14.minutes.signed" },
        { kind: "outbox", event: "m14.packet.frozen" },
      ]);
    }

    case "CANCEL":
      // §2.2 — terminal; guarded by the per-patient review floor (M14-F01 / ADR-0018 D2). The warn-to-
      // attendees fanout is M36's composition off `m14.meeting.cancelled` (ADR-0024), not an M14 effect.
      return result(from, event.type, "cancelled", [
        ...reviewFloorEffects(event.reason, event),
        { kind: "outbox", event: "m14.meeting.cancelled" },
      ]);

    case "RESCHEDULE":
      // §2.2 — terminal for this row; spawns a new meeting with `rescheduled_from_meeting_id` set.
      return result(from, event.type, "rescheduled", [
        ...reviewFloorEffects(event.reason, event),
        { kind: "spawn_rescheduled_meeting" },
        { kind: "outbox", event: "m14.meeting.rescheduled" },
      ]);
  }
}
