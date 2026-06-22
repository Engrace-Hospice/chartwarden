// @wardenx/scheduling — §2.2.1 D3 visit lifecycle state machine (M17-T03). Pure, IO-free.
//
// The §2.2.1 eight-state visit machine (M17-F03 reconciled — `evv_missing_attested`/`reassignment_needed`
// are NOT states):
//
//   proposed ─publish→ published ─start→ en_route ─arrive→ in_visit ─complete→ completed
//      │                  │ │ │                                  │
//      └dismiss→ cancelled│ │ └no_show→ no_show     {en_route|in_visit} ─cancel→ cancelled
//                         │ └reschedule→ rescheduled (+ new visit in proposed/published, same tx)
//                         └cancel→ cancelled
//
// Pure transition function (the M8/M11/M14 convention): it validates the event is legal from the current
// state (the §2.2.1 graph — nothing transitions on a string match), runs the enumerated guards (failures
// raise the precise §2.2 code via SchedulingStateError), and returns the new state + the §2.4 in-
// transaction side-effect list the service executes (always including the §2.2.2 `visit_state_history`
// append). No IO; every fact a guard needs (the D8 pre-schedule gate verdict, the EVV source, the actor,
// the documented reasons, step-up freshness) is resolved upstream and passed in. The D8 gate orchestrator
// (which composes the seven predicates against the M2/M5/M15 readers) lands in M17-T07; here `publish`
// takes the already-computed `gatePassed` verdict.
import type { VisitStatus } from "@wardenx/types";
import { EVV_MISSING_SELF_ATTEST_MIN_REASON_LENGTH } from "../policy";
import {
  VISIT_CANCEL_REASON_MIN_LENGTH,
  VISIT_RESCHEDULE_REASON_MIN_LENGTH,
} from "./reason-floors";
import { type SchedulingSideEffect, type SchedulingTransitionResult, result } from "./effects";
import { SchedulingStateError, require_ } from "./errors";

export type VisitState = VisitStatus;

/** Where a `published → en_route` / `en_route → in_visit` advance originates (§2.2.1 guards). */
export type VisitAdvanceSource =
  /** An `m18.evv.check_in_recorded` / `m18.evv.at_patient_address` event matched this visit (system actor). */
  | { readonly via: "evv" }
  /** The assigned clinician self-attested via `POST /visits/:id/start` (no EVV / telephonic) — requires a
   * documented `evv_missing_reason` (≥ 40 chars) + an M2 SESSION_POLICY step-up (§2.2.1 / D3). */
  | { readonly via: "self_attest"; readonly evvMissingReason: string; readonly stepUpSatisfied: boolean };

/** The §2.2.1 visit lifecycle events. Per-event facts are resolved upstream and injected as data. */
export type VisitEvent =
  | {
      readonly type: "publish";
      /** §2.2.1 — the D8 seven-predicate pre-schedule gate passed (orchestrated at M17-T07). */
      readonly gatePassed: boolean;
    }
  | {
      readonly type: "dismiss";
      /** §2.2.4 — the parent proposal was rejected (no published event ever fired; chart-invisible). */
      readonly reason?: string;
    }
  | { readonly type: "start"; readonly source: VisitAdvanceSource }
  | { readonly type: "arrive"; readonly source: VisitAdvanceSource }
  | {
      readonly type: "complete";
      /** §2.2.1 — fired by the `m8.encounter.signed` consumer referencing this `visit_id` (system actor). */
      readonly isSystemActor: boolean;
    }
  | {
      readonly type: "cancel";
      /** §2.2.1 / §2.3 — `cancellation_reason ≥ 20 chars`. */
      readonly reason: string;
      /** §2.2.1 — `cancelled_by_membership_id` is required after `proposed`. */
      readonly cancelledByPresent: boolean;
    }
  | {
      readonly type: "reschedule";
      /** §2.2.1 / §2.3 — `reschedule_reason ≥ 20 chars`; the new visit row is inserted in the same tx. */
      readonly reason: string;
    }
  | {
      readonly type: "no_show";
      /** §2.2.1 — the documented no-show note (denylisted from audit per §3.6). */
      readonly reason?: string;
    };

export type VisitTransition = SchedulingTransitionResult<VisitState, VisitEvent["type"]>;

/** The legal §2.2.1 transition graph (from → events accepted). Guards are checked separately. */
export const VISIT_GRAPH: Readonly<Record<VisitState, ReadonlyArray<VisitEvent["type"]>>> = {
  proposed: ["publish", "dismiss"],
  published: ["start", "cancel", "reschedule", "no_show"],
  en_route: ["arrive", "cancel"],
  in_visit: ["complete", "cancel"],
  completed: [],
  no_show: [],
  cancelled: [],
  rescheduled: [],
};

/** The §2.2.2 history-append + audit effects every transition carries (system-driven ⇒ NULL actor). */
function trace(
  from: VisitState,
  to: VisitState,
  reason: string | null,
  systemDriven: boolean,
): ReadonlyArray<SchedulingSideEffect> {
  return [
    { kind: "write_state_history", from, to, reason, systemDriven },
    { kind: "bump_version" },
    { kind: "audit" },
  ];
}

/** Resolve a `start`/`arrive` advance source into its guard effects (EVV bracket + reason capture). */
function advanceSourceEffects(source: VisitAdvanceSource): ReadonlyArray<SchedulingSideEffect> {
  if (source.via === "evv") {
    return [{ kind: "set_evv_bracket", state: "evv_present" }];
  }
  require_(
    source.stepUpSatisfied,
    "EVV_SELF_ATTEST_STEP_UP_REQUIRED",
    "the EVV-missing self-attest path requires an M2 SESSION_POLICY step-up",
  );
  require_(
    source.evvMissingReason.trim().length >= EVV_MISSING_SELF_ATTEST_MIN_REASON_LENGTH,
    "EVV_MISSING_REASON_TOO_SHORT",
    `the documented EVV-missing reason must be at least ${EVV_MISSING_SELF_ATTEST_MIN_REASON_LENGTH} characters`,
  );
  return [
    { kind: "set_evv_bracket", state: "evv_missing_documented" },
    { kind: "capture_reason", field: "evv_missing_reason", value: source.evvMissingReason },
  ];
}

/**
 * Apply a visit lifecycle event (§2.2.1). Throws {@link SchedulingStateError} `ILLEGAL_VISIT_TRANSITION`
 * if the event is not accepted from `from`, or the specific §2.2 guard code on a guard failure. Returns the
 * new state + the ordered §2.4 side-effect list (history append + audit + outbox) the service runs in the
 * visit's optimistic-locked tx.
 */
export function transitionVisit(from: VisitState, event: VisitEvent): VisitTransition {
  if (!VISIT_GRAPH[from].includes(event.type)) {
    throw new SchedulingStateError(
      "ILLEGAL_VISIT_TRANSITION",
      `visit cannot ${event.type} from '${from}'`,
    );
  }

  switch (event.type) {
    case "publish": {
      require_(
        event.gatePassed,
        "VISIT_PRE_SCHEDULE_GATE_UNMET",
        "the pre-schedule gate (D8) must pass before a proposed visit can be published",
      );
      return result(from, event.type, "published", [
        ...trace(from, "published", null, false),
        { kind: "set_timestamp", field: "published_at" },
        // §2.4 — caseload contribution + the M8/M18/M20/M31 visit-seeding stream.
        { kind: "outbox", event: "m17.visit.assigned" },
        { kind: "outbox", event: "m17.visit.published" },
        { kind: "alert", alert: "visit_assigned" },
      ]);
    }

    case "dismiss": {
      // §2.2.4 — a proposed visit was never visible to chart consumers: no caseload/visit-seeding event.
      return result(from, event.type, "cancelled", trace(from, "cancelled", event.reason ?? null, false));
    }

    case "start": {
      // §2.2.1 EVV-driven advance is system-actor; the self-attest alternative is the explicit human path.
      return result(from, event.type, "en_route", [
        ...trace(from, "en_route", null, event.source.via === "evv"),
        ...advanceSourceEffects(event.source),
        { kind: "set_timestamp", field: "started_at" },
        { kind: "outbox", event: "m17.visit.started" },
      ]);
    }

    case "arrive": {
      return result(from, event.type, "in_visit", [
        ...trace(from, "in_visit", null, event.source.via === "evv"),
        ...advanceSourceEffects(event.source),
        { kind: "set_timestamp", field: "arrived_at" },
      ]);
    }

    case "complete": {
      require_(
        event.isSystemActor,
        "NOT_SYSTEM_ACTOR",
        "a visit completes only on the `m8.encounter.signed` consumer (system actor)",
      );
      return result(from, event.type, "completed", [
        ...trace(from, "completed", null, true),
        { kind: "set_timestamp", field: "completed_at" },
        { kind: "outbox", event: "m17.visit.completed" },
      ]);
    }

    case "cancel": {
      require_(
        event.cancelledByPresent,
        "VISIT_CANCELLED_BY_REQUIRED",
        "a cancellation after `proposed` requires `cancelled_by_membership_id`",
      );
      require_(
        event.reason.trim().length >= VISIT_CANCEL_REASON_MIN_LENGTH,
        "VISIT_CANCELLATION_REASON_TOO_SHORT",
        `the cancellation reason must be at least ${VISIT_CANCEL_REASON_MIN_LENGTH} characters`,
      );
      return result(from, event.type, "cancelled", [
        ...trace(from, "cancelled", event.reason, false),
        { kind: "capture_reason", field: "cancellation_reason", value: event.reason },
        // §2.4 — caseload contribution removal + the cancelled event (caregiver reminder is M22+M36 opt-in).
        { kind: "outbox", event: "m17.visit.unassigned" },
        { kind: "outbox", event: "m17.visit.cancelled" },
        { kind: "alert", alert: "visit_cancelled" },
      ]);
    }

    case "reschedule": {
      require_(
        event.reason.trim().length >= VISIT_RESCHEDULE_REASON_MIN_LENGTH,
        "VISIT_RESCHEDULE_REASON_TOO_SHORT",
        `the reschedule reason must be at least ${VISIT_RESCHEDULE_REASON_MIN_LENGTH} characters`,
      );
      // §2.4 — the original goes to `rescheduled`; the service inserts the new visit (proposed/published)
      // and links it via `rescheduled_into_visit_id` in the same tx. The new visit's own history row +
      // `m17.visit.assigned` are produced by that insert's own transition (publish) or factory.
      return result(from, event.type, "rescheduled", [
        ...trace(from, "rescheduled", event.reason, false),
        { kind: "capture_reason", field: "reschedule_reason", value: event.reason },
        { kind: "link_rescheduled_into" },
        { kind: "outbox", event: "m17.visit.unassigned" },
        { kind: "outbox", event: "m17.visit.rescheduled" },
        { kind: "alert", alert: "visit_rescheduled" },
      ]);
    }

    case "no_show": {
      return result(from, event.type, "no_show", [
        ...trace(from, "no_show", event.reason ?? null, false),
        ...(event.reason
          ? ([{ kind: "capture_reason", field: "no_show_reason", value: event.reason }] as const)
          : []),
        { kind: "outbox", event: "m17.visit.unassigned" },
        { kind: "outbox", event: "m17.visit.no_show_detected" },
        { kind: "alert", alert: "visit_no_show" },
      ]);
    }
  }
}

/**
 * The genesis of a visit: a `proposed` row (§2.2.1). There is no prior state, so this is a factory, not a
 * transition — the parent (a recurring-policy materialization, a frequency proposal publish, or a manual
 * scheduler insert) is resolved upstream. Returns the §2.4 effect list the service runs in the create tx
 * (the genesis `visit_state_history` row + audit + the `m17.visit.proposed` outbox event).
 */
export function planVisitProposed(): ReadonlyArray<SchedulingSideEffect> {
  return [
    { kind: "write_state_history", from: "proposed", to: "proposed", reason: null, systemDriven: true },
    { kind: "audit" },
    { kind: "outbox", event: "m17.visit.proposed" },
  ];
}
