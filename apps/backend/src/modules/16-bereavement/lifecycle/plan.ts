// apps/backend/src/modules/16-bereavement/lifecycle/plan.ts — M16-T03 (§2.2).
//
// The `bereavement_plan` ROOT lifecycle: eligible → initiating → active ⇄ paused → one of three closed
// states, with M4's legal hold as an orthogonal extension of the retention clock (never a re-opening of the
// program). One row per (organization_id, admission_id) — `berv_plan_unique_admission` is the structural
// backstop; the plan is INSERTED in `eligible` by the §4.3.1 `m6.bereavement.eligible` intake (see
// ../consumers/m6-eligibility.ts) and never by a human.
//
// Two deliberate readings of the spec, both documented at their guard:
//
//   • §2.2's diagram draws `skipPerPatientOptOut` only from `eligible`, but §2.6 states the D9 flag flip
//     fires it "after the plan is in eligible OR initiating". The narrative is the more specific rule and
//     the graph here accepts both — the alternative would strand a plan that had a counselor assigned in
//     the very window the survivor's directive arrived.
//   • `legalHoldReleased` returns the plan to "closed_completed (or original close-state)". The original
//     state is NOT stored (the hold overwrote `status`), so it is DERIVED from the closure row's reason via
//     {@link closeStateForReason} — the closure row is the durable record of why the program ended.
//
// Pure transitions over already-resolved facts; the per-contact machine lives in ./contact, the touchpoint
// machine in ./outreach, and the D4 schedule materialization in ./schedule.
import {
  EARLY_CLOSE_REASON_MIN_LENGTH,
  isClosedPlanStatus,
  requiresCloseCosign,
  shouldCloseAsDeclined,
} from "@wardenx/bereavement";
import type {
  BereavedContactStatus,
  BereavementAnniversaryMark,
  BereavementExternalSourceMetadata,
  BereavementPlanClosureReason,
  BereavementPlanPauseKind,
  BereavementPlanStatus,
  IsoInstant,
  MembershipId,
} from "@wardenx/types";
import { type BereavementTransitionResult, result } from "./effects";
import { BereavementStateError, require_ } from "./errors";

/** The §2.2 plan-root states (mirrors `bereavement_plan_status`). */
export type BereavementPlanLifecycleState = BereavementPlanStatus;

/** The §2.2 plan-root events. */
export type BereavementPlanEvent =
  | {
      /** D9 — the M5 per-patient directive said no. Closes the plan without ever opening an M36 channel. */
      readonly type: "skipPerPatientOptOut";
      readonly at: IsoInstant;
    }
  | {
      /** §2.2 — a counselor with `discipline_can_provide_bereavement` takes the plan. */
      readonly type: "assignCounselor";
      readonly counselorUserId: MembershipId;
      readonly at: IsoInstant;
      /** The M40 discipline-taxonomy answer for the target user (§2.5, resolved by the ABAC predicate). */
      readonly counselorCanProvideBereavement: boolean;
    }
  | {
      /** §2.2 — the roster is seeded, the initial risk score exists, and the D4 schedule materializes. */
      readonly type: "seedRosterAndSchedule";
      readonly at: IsoInstant;
      /** The bereaved-contact rows seeded from M5 + the counselor's additions (§2.2 guard: ≥ 1). */
      readonly contactCount: number;
      /** §2.2 guard — the initial deterministic score was computed before the plan may go live. */
      readonly initialRiskScored: boolean;
      /** `death_date + 13 months` — M36 pre-computes its channel `archives_at` from this (D4). */
      readonly archivesAt: IsoInstant;
      /** The D4 milestone rows to insert into `bereavement_anniversary_reminder`. */
      readonly anniversaryMarks: ReadonlyArray<BereavementAnniversaryMark>;
    }
  | {
      /** D18 — an inbound `m6.discharge.cosigned` released the external-source first-contact gate. The
       *  plan's STATE does not move; only `external_source_metadata` does. */
      readonly type: "receiveCosign";
      readonly metadata: BereavementExternalSourceMetadata;
    }
  | {
      readonly type: "pausePlan";
      readonly pauseKind: BereavementPlanPauseKind;
      /** §2.2 guard — a pause without a recorded reason is not a pause, it is a lapse. */
      readonly reason: string;
      readonly at: IsoInstant;
    }
  | {
      readonly type: "resumePlan";
      readonly at: IsoInstant;
    }
  | {
      /** D6 — every enrollee opted out. The guard is over the FULL roster, never over "nobody engageable". */
      readonly type: "closeOnAllContactsOptedOut";
      readonly contactStatuses: ReadonlyArray<BereavedContactStatus>;
      readonly at: IsoInstant;
    }
  | {
      /** D7 — the cosigned early close, plus the two D9 cosign-EXEMPT patient-opt-out reasons. */
      readonly type: "closeEarly";
      readonly reason: BereavementPlanClosureReason;
      readonly narrative: string;
      readonly at: IsoInstant;
      /** D7 — the clinical supervisor who ratified it; null on the cosign-exempt reasons. */
      readonly cosignedByUserId: MembershipId | null;
      /** M4 — an active hold does not stop the program from closing, but the erase clock is M4's. */
      readonly legalHoldActive?: boolean;
    }
  | {
      /** §7.11 — the 13-month auto-close worker. Idempotent by construction: a closed plan no longer
       *  accepts the event, so a redelivery lands on ILLEGAL_TRANSITION rather than a second closure row. */
      readonly type: "closeAt13Months";
      readonly at: IsoInstant;
      /** D4 — `now() >= death_date + 396 days`, decided by `isWithinBereavementWindow` at the caller. */
      readonly windowElapsed: boolean;
      readonly legalHoldActive?: boolean;
    }
  | {
      /** M4 applied a legal-hold tombstone for the `bereavement` retention class. */
      readonly type: "legalHoldApplied";
      readonly legalHoldId: string;
    }
  | {
      /** M4 released it — the plan returns to the close state its closure reason implies. */
      readonly type: "legalHoldReleased";
      /** The `bereavement_plan_closure.reason` on the plan's closure row (the durable record). */
      readonly closureReason: BereavementPlanClosureReason;
    };

export type BereavementPlanTransition = BereavementTransitionResult<
  BereavementPlanLifecycleState,
  BereavementPlanEvent["type"]
>;

/**
 * The legal §2.2 transition graph (from → events accepted). `receiveCosign` appears on every non-closed
 * state because a medical-director cosign can land at any point before the program ends — including after
 * the counselor already worked the plan — and dropping it would leave `cosignStatus='pending'` forever.
 */
export const BEREAVEMENT_PLAN_GRAPH: Readonly<
  Record<BereavementPlanLifecycleState, ReadonlyArray<BereavementPlanEvent["type"]>>
> = {
  eligible: ["skipPerPatientOptOut", "assignCounselor", "receiveCosign"],
  initiating: ["skipPerPatientOptOut", "seedRosterAndSchedule", "receiveCosign"],
  active: [
    "pausePlan",
    "closeOnAllContactsOptedOut",
    "closeEarly",
    "closeAt13Months",
    "receiveCosign",
  ],
  paused: ["resumePlan", "closeEarly", "closeAt13Months", "receiveCosign"],
  closed_completed: ["legalHoldApplied"],
  closed_declined: ["legalHoldApplied"],
  closed_early: ["legalHoldApplied"],
  closed_legal_hold_extended: ["legalHoldReleased"],
};

/**
 * §2.2 — which closed state a closure reason lands in. This is also the inverse `legalHoldReleased` uses to
 * restore the pre-hold state, which is why it lives next to the graph rather than inside one transition.
 *
 * `patient_opt_out_pre_death` maps to `closed_completed` (§2.2's `skipPerPatientOptOut` row) while
 * `patient_opt_out_post_creation` maps to `closed_early` (§2.6's automatic, cosign-exempt `closeEarly`) —
 * the two D9 reasons deliberately differ because one program never started and the other was cut short.
 */
export function closeStateForReason(
  reason: BereavementPlanClosureReason,
): Extract<BereavementPlanLifecycleState, "closed_completed" | "closed_declined" | "closed_early"> {
  switch (reason) {
    case "thirteen_month_completion":
    case "patient_opt_out_pre_death":
      return "closed_completed";
    case "all_contacts_declined":
      return "closed_declined";
    default:
      return "closed_early";
  }
}

/** The result of the §4.3.1 intake insert (`[*] → eligible`). */
export interface BereavementPlanIntake {
  readonly status: "eligible";
  readonly deathDate: string;
  readonly externalSourceMetadata: BereavementExternalSourceMetadata | null;
  readonly effects: BereavementPlanTransition["effects"];
}

/**
 * The `[*] → eligible` factory (§2.2 / §4.3.1). Called by the `m6.bereavement.eligible` consumer once the
 * death fact is resolved. Emits NO outbox event on purpose: per D2 the program's public "a plan exists"
 * signal is `m16.bereavement.plan_opened`, which fires at `active` — announcing an `eligible` row would
 * have M36 open a channel for a plan that may be skipped by a D9 opt-out one transition later.
 */
export function intakeBereavementPlan(
  deathDate: string,
  externalSourceMetadata: BereavementExternalSourceMetadata | null,
): BereavementPlanIntake {
  return {
    status: "eligible",
    deathDate,
    externalSourceMetadata,
    effects: [{ kind: "audit" }],
  };
}

/** Apply a `bereavement_plan` root event (§2.2). Throws `ILLEGAL_TRANSITION` if not accepted. */
export function transitionBereavementPlan(
  from: BereavementPlanLifecycleState,
  event: BereavementPlanEvent,
): BereavementPlanTransition {
  if (!BEREAVEMENT_PLAN_GRAPH[from].includes(event.type)) {
    throw new BereavementStateError(
      "ILLEGAL_TRANSITION",
      `bereavement plan cannot ${event.type} from '${from}'`,
    );
  }

  switch (event.type) {
    case "skipPerPatientOptOut": {
      // D9 — the patient (or their DPOA) declined the program before death. The closure row records it as
      // `patient_opt_out_pre_death` and NO M36 channel opens; §2.2 is explicit that this is a completed
      // program, not a declined one — the family never refused anything.
      //
      // F-159 (#248): a plan reaching `skip` from `eligible`/`initiating` never ran `seedRosterAndSchedule`
      // (the only transition that sets `opened_at`) — yet `closed_completed` is one of the statuses
      // `berv_plan_active_requires_counselor`'s sibling constraint `berv_plan_opened_at_required`
      // (migration 0100) requires a non-null `opened_at` for. Stamping it to the SAME instant as
      // `closed_at` is honest, not fabricated: it records that this program's whole lifetime — from never
      // opening to being closed — was zero, which is exactly what happened, and lets a "days open" report
      // compute 0 rather than choke on a NULL.
      return result(from, event.type, "closed_completed", [
        { kind: "set_timestamp", field: "opened_at", at: event.at },
        { kind: "set_timestamp", field: "closed_at", at: event.at },
        {
          kind: "insert_closure",
          reason: "patient_opt_out_pre_death",
          closeKind: "cascade",
          cosignRequired: false,
        },
        { kind: "audit" },
        { kind: "outbox", event: "m16.bereavement.plan_skipped_per_patient_opt_out" },
      ]);
    }
    case "assignCounselor": {
      // §2.5 — the target must resolve `discipline_can_provide_bereavement` AT ASSIGNMENT TIME. A
      // volunteer coordinator or an aide cannot hold the plan even if they hold the permission key.
      require_(
        event.counselorCanProvideBereavement,
        "COUNSELOR_NOT_BEREAVEMENT_ELIGIBLE",
        "the assigned user's discipline may not provide bereavement services",
      );
      return result(from, event.type, "initiating", [
        {
          kind: "set_assignment",
          role: "counselor",
          membershipId: event.counselorUserId,
          at: event.at,
        },
        { kind: "audit" },
        { kind: "outbox", event: "m16.bereavement.counselor_assigned" },
      ]);
    }
    case "seedRosterAndSchedule": {
      // §2.2 — a plan cannot go live with nobody to serve, and cannot schedule a cadence without a tier.
      require_(
        event.contactCount > 0,
        "ROSTER_EMPTY",
        "a bereavement plan needs at least one bereaved contact before it opens",
      );
      require_(
        event.initialRiskScored,
        "INITIAL_RISK_SCORE_REQUIRED",
        "the initial deterministic risk score must exist before the D4 cadence can be generated",
      );
      // NOTE: the D18 external-source gate is NOT evaluated here — it gates counselor FIRST CONTACT
      // (§4.3.2 `initiateBereavementContact`), not the plan opening. A gated plan still opens, schedules,
      // and shows the coordinator banner; only reaching out to the family waits on the cosign.
      return result(from, event.type, "active", [
        { kind: "set_timestamp", field: "opened_at", at: event.at },
        { kind: "generate_schedule" },
        { kind: "seed_anniversary_reminders", marks: event.anniversaryMarks },
        { kind: "audit" },
        { kind: "outbox", event: "m16.bereavement.plan_opened" },
        { kind: "outbox", event: "m16.bereavement.outreach_artifact_requested" },
      ]);
    }
    case "receiveCosign": {
      // D18 — state unchanged; the metadata write is the whole transition. The coordinator UI refreshes off
      // the outbox event and the counselor's first-contact button unlocks.
      return result(from, event.type, from, [
        { kind: "set_external_source_metadata", metadata: event.metadata },
        { kind: "audit" },
        { kind: "outbox", event: "m16.bereavement.external_source_cosign_received" },
      ]);
    }
    case "pausePlan": {
      require_(
        event.reason.trim().length > 0,
        "PAUSE_REASON_REQUIRED",
        "a plan pause must record why",
      );
      return result(from, event.type, "paused", [
        { kind: "set_timestamp", field: "paused_at", at: event.at },
        { kind: "cancel_future_outreach", scope: "plan" },
        { kind: "audit" },
        { kind: "outbox", event: "m16.bereavement.plan_paused" },
      ]);
    }
    case "resumePlan": {
      // §2.2 — the forward schedule is regenerated FROM NOW to the window end, never replayed from the
      // death date: a touchpoint whose due date passed during the pause is gone, and re-materializing it
      // would manufacture a backdated obligation the agency could never have met.
      return result(from, event.type, "active", [
        { kind: "regenerate_schedule", fromIso: event.at, scope: "plan" },
        { kind: "audit" },
        { kind: "outbox", event: "m16.bereavement.plan_resumed" },
      ]);
    }
    case "closeOnAllContactsOptedOut": {
      // D6 — "every contact opted out", not "no contact is engageable". A roster of one deceased and one
      // unreachable survivor is an operational problem, and closing it as `declined` would put a false
      // "the family refused bereavement services" on the survey record.
      require_(
        shouldCloseAsDeclined(event.contactStatuses),
        "NOT_ALL_CONTACTS_OPTED_OUT",
        "closed_declined requires every bereaved contact to have opted out",
      );
      return result(from, event.type, "closed_declined", [
        { kind: "set_timestamp", field: "closed_at", at: event.at },
        {
          kind: "insert_closure",
          reason: "all_contacts_declined",
          closeKind: "cascade",
          cosignRequired: false,
        },
        { kind: "cancel_future_outreach", scope: "plan" },
        { kind: "audit" },
        { kind: "outbox", event: "m16.bereavement.plan_closed_declined" },
      ]);
    }
    case "closeEarly": {
      const cosignRequired = requiresCloseCosign(event.reason);
      // D7 — the 40-char floor applies to the reasons a supervisor must ratify. The two D9 patient-opt-out
      // reasons are system-driven cascades with a fixed narrative, so holding them to a prose floor would
      // only teach the worker to pad text.
      if (cosignRequired) {
        require_(
          event.narrative.trim().length >= EARLY_CLOSE_REASON_MIN_LENGTH,
          "EARLY_CLOSE_REASON_TOO_SHORT",
          `an early-close narrative must be at least ${EARLY_CLOSE_REASON_MIN_LENGTH} characters`,
        );
        require_(
          event.cosignedByUserId !== null,
          "EARLY_CLOSE_COSIGN_REQUIRED",
          "an early close requires a clinical-supervisor cosign",
        );
      }
      require_(
        event.legalHoldActive !== true,
        "LEGAL_HOLD_ACTIVE",
        "a plan under an active M4 legal hold cannot be closed early",
      );
      return result(from, event.type, "closed_early", [
        { kind: "set_timestamp", field: "closed_at", at: event.at },
        {
          kind: "insert_closure",
          reason: event.reason,
          closeKind: cosignRequired ? "manual" : "cascade",
          cosignRequired,
        },
        { kind: "cancel_future_outreach", scope: "plan" },
        { kind: "audit" },
        { kind: "outbox", event: "m16.bereavement.plan_closed_early" },
      ]);
    }
    case "closeAt13Months": {
      require_(
        event.windowElapsed,
        "BEREAVEMENT_WINDOW_STILL_OPEN",
        "the 13-month bereavement window has not elapsed",
      );
      require_(
        event.legalHoldActive !== true,
        "LEGAL_HOLD_ACTIVE",
        "a plan under an active M4 legal hold cannot be auto-closed",
      );
      return result(from, event.type, "closed_completed", [
        { kind: "set_timestamp", field: "closed_at", at: event.at },
        {
          kind: "insert_closure",
          reason: "thirteen_month_completion",
          closeKind: "auto",
          cosignRequired: false,
        },
        { kind: "cancel_future_outreach", scope: "plan" },
        { kind: "audit" },
        { kind: "outbox", event: "m16.bereavement.plan_closed_completed" },
      ]);
    }
    case "legalHoldApplied": {
      // §2.2 — NO outbox emit: M4 owns the hold-applied event, and a second announcement from M16 would
      // give consumers two sources of truth for one fact.
      return result(from, event.type, "closed_legal_hold_extended", [
        { kind: "set_legal_hold", legalHoldId: event.legalHoldId },
        { kind: "audit" },
      ]);
    }
    case "legalHoldReleased": {
      return result(from, event.type, closeStateForReason(event.closureReason), [
        { kind: "clear_legal_hold" },
        { kind: "audit" },
      ]);
    }
  }
}

/** §2.2 — true when no further outreach may be scheduled against the plan (re-exported for the routes). */
export function isPlanClosed(status: BereavementPlanLifecycleState): boolean {
  return isClosedPlanStatus(status);
}

/** §2.2 — guard for any write path that requires a live program (`PLAN_CLOSED` / `PLAN_NOT_ACTIVE`). */
export function checkPlanWritable(status: BereavementPlanLifecycleState): void {
  require_(!isClosedPlanStatus(status), "PLAN_CLOSED", `the bereavement plan is ${status}`);
}
