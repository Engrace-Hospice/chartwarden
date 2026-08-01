// apps/backend/src/modules/20-field-safety/consumers/m17-no-show.ts — M20-T04 (§4.8
// `m20.no-show.consumer`).
//
// §4.8's whole specification of this consumer is six words: "Open warn-severity inquiry to supervisor".
// Two things about M20's own vocabulary decide what that can mean.
//
// AN INQUIRY WITH NO SCHEDULE ROW IS UNEMITTABLE. `M20CheckInOverduePayload.scheduleId` is
// non-nullable and so is `SafetyCheckInOverdueAlert.scheduleId` (@wardenx/types, §4.10 / §4.9) — the warn
// channel M20 owns is anchored to an obligation, not to a visit. So the consumer keeps ONE obligation as
// the inquiry's anchor and retires the others; it never synthesises an event with nothing behind it.
//
// AND THE ANCHOR HAS TO BE GENUINELY OVERDUE. `m20.safety.check_in_overdue` states something specific —
// this clinician has not answered a safety prompt that was due — and firing it about a clinician who
// answered every prompt she was given is how a safety board earns the right to be ignored. So when every
// obligation is either already answered or still in the FUTURE at the moment M17 detected the no-show,
// M20 emits no inquiry at all and only retires the obligations the cancelled visit made moot. The
// patient-side arm of the same event is M19's `source='no_show'` welfare-check call (M19 §7.6); M20's arm
// is the clinician's, and it is bounded by what M20 can truthfully say.
//
// WHY THE OTHERS ARE RETIRED RATHER THAN LEFT: a mid-visit prompt for a visit that never happened would
// go overdue at its scheduled minute and walk the full D4 ladder — a supervisor paged at `critical` about
// a clinician who is demonstrably fine. `./schedule-plan` explains why retirement is a DELETE: no member
// of `safety_check_in_state` can say "this plan was invalidated" without lying.
import type { IsoInstant, SafetyCheckInKind, SafetyCheckInScheduleId } from "@wardenx/types";
import { withAudit } from "../lifecycle/effects";
import {
  type SafetyConsumerDecision,
  type SafetyScheduleMutation,
  type SafetyScheduleRowFacts,
  isOpenObligation,
  minutesBetween,
} from "./schedule-plan";

/** The obligation an inquiry was anchored to, for the §4.10 / §4.9 payloads the runner builds. */
export interface SafetyNoShowInquiry {
  readonly scheduleId: SafetyCheckInScheduleId;
  readonly kind: SafetyCheckInKind;
  readonly expectedAt: IsoInstant;
  readonly minutesOverdue: number;
}

/** A no-show decision — the shared shape plus the inquiry's anchor (null when none was truthful). */
export interface SafetyNoShowDecision extends SafetyConsumerDecision {
  readonly inquiry: SafetyNoShowInquiry | null;
}

/**
 * §4.8 — `m17.visit.no_show_detected`.
 *
 * `detectedAt` is the trigger instant, NOT `now()`: a redelivered event minutes later must decide the same
 * way it would have on first delivery, or a retry storm turns one no-show into a ladder of its own.
 */
export function decideVisitNoShow(input: {
  readonly detectedAt: IsoInstant;
  readonly existing: readonly SafetyScheduleRowFacts[];
}): SafetyNoShowDecision {
  const open = input.existing.filter((row) => isOpenObligation(row.state));

  // An obligation already past its window and unanswered — the ladder is running or is about to. The
  // EARLIEST is the anchor: it is the one whose silence is longest and the one a supervisor asks about.
  const alreadyRaised = open.some((row) => row.state === "overdue" || row.state === "escalated");
  const anchorCandidates = open
    .filter(
      (row) =>
        row.state === "proposed" &&
        minutesBetween(row.expectedAt, input.detectedAt) >= row.windowMinutes,
    )
    .sort((a, b) => Date.parse(a.expectedAt) - Date.parse(b.expectedAt));
  const anchor = alreadyRaised ? null : (anchorCandidates[0] ?? null);

  const mutations: SafetyScheduleMutation[] = [];
  if (anchor !== null) {
    mutations.push({
      kind: "mark_overdue",
      scheduleId: anchor.scheduleId,
      overdueDetectedAt: input.detectedAt,
    });
  }
  for (const row of input.existing) {
    if (row.state !== "proposed") continue;
    if (anchor !== null && row.scheduleId === anchor.scheduleId) continue;
    mutations.push({ kind: "retire", scheduleId: row.scheduleId, reason: "visit_no_show" });
  }

  const inquiry: SafetyNoShowInquiry | null =
    anchor === null
      ? null
      : {
          scheduleId: anchor.scheduleId,
          kind: anchor.kind,
          expectedAt: anchor.expectedAt,
          minutesOverdue: minutesBetween(anchor.expectedAt, input.detectedAt),
        };

  return {
    mutations,
    effects:
      inquiry === null
        ? mutations.length === 0
          ? []
          : withAudit([])
        : // The state flip and its `overdue_detected_at` stamp ride on the `mark_overdue` MUTATION, which
          // names the row they land on; restating them as effects would give one write two owners.
          withAudit([
            { kind: "outbox", event: "m20.safety.check_in_overdue" },
            { kind: "alert", alert: "m20.safety.check_in_overdue" },
          ]),
    skipped: [],
    inquiry,
  };
}
