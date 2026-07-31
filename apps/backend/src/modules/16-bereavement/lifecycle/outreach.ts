// apps/backend/src/modules/16-bereavement/lifecycle/outreach.ts — M16-T03 (§2.4).
//
// The `bereavement_outreach` lifecycle: the row is the scheduled future INTENT, and
// `bereavement_contact_log` is the record that the touchpoint happened (or didn't). The split is what lets
// one outreach ("mail the anniversary letter") produce three contact-log rows — one per addressee — all
// referencing a single M22-rendered document.
//
// D15 lives on `completeContact`: `in_person_visit` is the ONLY kind backed by an M8 encounter, and every
// other kind must NOT carry a `source_encounter_id`. Both directions are DB CHECKs on the contact log as
// well; the guard here is what turns the constraint into a 422 with a code the UI can render instead of a
// raw PG violation.
import { requiresSourceEncounter } from "@wardenx/bereavement";
import type {
  BereavementContactLogOutcome,
  BereavementOutreachKind,
  BereavementOutreachStatus,
  EncounterId,
  IsoInstant,
} from "@wardenx/types";
import { type BereavementTransitionResult, result } from "./effects";
import { BereavementStateError, require_ } from "./errors";

/** The §2.4 touchpoint states (mirrors `bereavement_outreach_status`). */
export type BereavementOutreachLifecycleState = BereavementOutreachStatus;

/** The §2.4 touchpoint events. */
export type BereavementOutreachEvent =
  | {
      /** The counselor or volunteer starts the call / opens the M8 draft / queues the M22 letter. */
      readonly type: "startContact";
      readonly at: IsoInstant;
    }
  | {
      readonly type: "completeContact";
      readonly at: IsoInstant;
      readonly kind: BereavementOutreachKind;
      readonly outcome: BereavementContactLogOutcome;
      /** D15 — required for `in_person_visit`, forbidden for every other kind. */
      readonly sourceEncounterId: EncounterId | null;
      /** §2.4 — completion means at least one `bereavement_contact_log` row exists. */
      readonly contactLogCount: number;
    }
  | {
      /** The survivor declined THIS touchpoint — not the program. The forward schedule continues. */
      readonly type: "contactDeclined";
      readonly at: IsoInstant;
    }
  | {
      readonly type: "noResponseAfterRetries";
      readonly at: IsoInstant;
      /** Consecutive no-responses INCLUDING this one — feeds the §2.3 3-strikes proposal. */
      readonly consecutiveNoResponseCount: number;
    }
  | {
      /** The hourly worker's verdict once `late_grace_until` has passed with no state change. */
      readonly type: "missDeadline";
      readonly at: IsoInstant;
      readonly lateGraceUntil: IsoInstant;
    }
  | {
      /** §2.4 — a missed touchpoint may still be attempted inside the late grace; audit-flagged, but NOT a
       *  compliance failure. */
      readonly type: "lateAttempt";
      readonly at: IsoInstant;
      readonly lateGraceUntil: IsoInstant;
    }
  | {
      /** Opt-out, plan pause/close, or a counselor cancellation. */
      readonly type: "cancel";
      readonly at: IsoInstant;
      readonly reason: string;
    };

export type BereavementOutreachTransition = BereavementTransitionResult<
  BereavementOutreachLifecycleState,
  BereavementOutreachEvent["type"]
>;

/** The legal §2.4 transition graph (from → events accepted). */
export const BEREAVEMENT_OUTREACH_GRAPH: Readonly<
  Record<BereavementOutreachLifecycleState, ReadonlyArray<BereavementOutreachEvent["type"]>>
> = {
  scheduled: ["startContact", "cancel", "missDeadline"],
  in_progress: ["completeContact", "contactDeclined", "noResponseAfterRetries", "cancel"],
  missed: ["lateAttempt"],
  completed: [],
  declined: [],
  no_response: [],
  cancelled: [],
};

/** The result of the `[*] → scheduled` generate (§2.4; the rows come from ./schedule). */
export interface BereavementOutreachGeneration {
  readonly status: "scheduled";
  readonly effects: BereavementOutreachTransition["effects"];
}

/** The `[*] → scheduled` factory (§2.4 `generate`). One row → one `outreach_scheduled` event so M33 can
 *  chart the forward book without reading M16's tables. */
export function generateBereavementOutreach(): BereavementOutreachGeneration {
  return {
    status: "scheduled",
    effects: [{ kind: "audit" }, { kind: "outbox", event: "m16.bereavement.outreach_scheduled" }],
  };
}

/**
 * D15 — assert a completion's encounter binding. Exported separately from the transition because the same
 * rule governs an ad-hoc `bereavement_contact_log` insert (route 26) that never had a scheduled outreach.
 */
export function checkSourceEncounterBinding(
  kind: BereavementOutreachKind,
  sourceEncounterId: EncounterId | null,
): void {
  if (requiresSourceEncounter(kind)) {
    require_(
      sourceEncounterId !== null,
      "SOURCE_ENCOUNTER_REQUIRED",
      "an in-person bereavement visit must reference the M8 encounter that documents it",
    );
    return;
  }
  require_(
    sourceEncounterId === null,
    "SOURCE_ENCOUNTER_FORBIDDEN",
    `a '${kind}' touchpoint is a direct M16 write and carries no M8 encounter`,
  );
}

/** Apply a `bereavement_outreach` event (§2.4). Throws `ILLEGAL_TRANSITION` if not accepted. */
export function transitionBereavementOutreach(
  from: BereavementOutreachLifecycleState,
  event: BereavementOutreachEvent,
): BereavementOutreachTransition {
  if (!BEREAVEMENT_OUTREACH_GRAPH[from].includes(event.type)) {
    throw new BereavementStateError(
      "ILLEGAL_TRANSITION",
      `bereavement outreach cannot ${event.type} from '${from}'`,
    );
  }

  switch (event.type) {
    case "startContact": {
      return result(from, event.type, "in_progress", [
        { kind: "set_timestamp", field: "started_at", at: event.at },
        { kind: "audit" },
      ]);
    }
    case "completeContact": {
      require_(
        event.contactLogCount > 0,
        "CONTACT_LOG_REQUIRED",
        "completing a touchpoint requires at least one contact-log row",
      );
      checkSourceEncounterBinding(event.kind, event.sourceEncounterId);
      return result(from, event.type, "completed", [
        { kind: "set_timestamp", field: "completed_at", at: event.at },
        { kind: "audit" },
        { kind: "outbox", event: "m16.bereavement.outreach_completed" },
      ]);
    }
    case "contactDeclined": {
      // Declining ONE touchpoint is not opting out: no `cancel_future_outreach`, no plan-level evaluation.
      return result(from, event.type, "declined", [
        { kind: "set_timestamp", field: "completed_at", at: event.at },
        { kind: "audit" },
        { kind: "outbox", event: "m16.bereavement.outreach_completed" },
      ]);
    }
    case "noResponseAfterRetries": {
      return result(from, event.type, "no_response", [
        { kind: "set_timestamp", field: "completed_at", at: event.at },
        { kind: "audit" },
        { kind: "outbox", event: "m16.bereavement.outreach_completed" },
      ]);
    }
    case "missDeadline": {
      // The worker may only call the miss once the LATE grace has passed, not merely once `due_at` did —
      // §2.4 gives the counselor the grace window, and a miss stamped at `due_at` would report a compliance
      // failure the agency still had seven days to prevent.
      require_(
        Date.parse(event.at) >= Date.parse(event.lateGraceUntil),
        "OUTREACH_NOT_YET_OVERDUE",
        "a touchpoint is only missed once its late grace has passed",
      );
      return result(from, event.type, "missed", [
        { kind: "audit" },
        { kind: "outbox", event: "m16.bereavement.outreach_missed" },
        { kind: "alert", alert: "outreach_missed" },
      ]);
    }
    case "lateAttempt": {
      require_(
        Date.parse(event.at) <= Date.parse(event.lateGraceUntil),
        "LATE_ATTEMPT_GRACE_EXPIRED",
        "the late-attempt grace window for this touchpoint has closed",
      );
      return result(from, event.type, "in_progress", [
        { kind: "set_timestamp", field: "started_at", at: event.at },
        { kind: "audit" },
      ]);
    }
    case "cancel": {
      require_(
        event.reason.trim().length > 0,
        "PAUSE_REASON_REQUIRED",
        "cancelling a scheduled touchpoint must record why",
      );
      return result(from, event.type, "cancelled", [
        { kind: "set_timestamp", field: "cancelled_at", at: event.at },
        { kind: "audit" },
      ]);
    }
  }
}
