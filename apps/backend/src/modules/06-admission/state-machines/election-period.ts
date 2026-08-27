// apps/backend/src/modules/06-admission/state-machines/election-period.ts — M6-T04 (§2.3.2).
//
// The ElectionPeriod lifecycle: pending → signed → active → completed. The no-overlap rule is enforced
// at the DB layer by the §2.2 GIST EXCLUDE constraint AND here in the service before commit, so the
// error envelope is the precise `ELECTION_PERIOD_OVERLAP` not a raw PG exception. Pure transition
// function over already-resolved facts (CTI signed, admission activated, the §2.4 election validators).
import type { LocalDate } from "@wardenx/types";
import { type ElectionEndCause, type TransitionResult, result } from "./effects";
import { AdmissionStateError, require_ } from "./errors";
import {
  checkCurativeCareAck,
  checkNoConcurrentElection,
  checkRepresentativeAuthority,
} from "./validation";

/** The §2.3.2 election-period states. */
export type ElectionPeriodState = "pending" | "signed" | "active" | "completed";

/** The §2.3.2 election-period events. */
export type ElectionPeriodEvent =
  | {
      readonly type: "signElectionStatement";
      readonly signerKind: "patient" | "representative";
      readonly hasActiveDpoaConsent: boolean;
      readonly curativeCareAcknowledgment: boolean;
      readonly existingActiveElectionElsewhere: boolean;
      readonly wouldOverlap: boolean;
    }
  | {
      readonly type: "setActive";
      readonly certificationSigned: boolean;
      readonly admissionActivated: boolean;
      readonly sequence: number;
      readonly f2fAttested: boolean;
      readonly effectiveAt: LocalDate;
    }
  | {
      readonly type: "complete";
      readonly cause: ElectionEndCause;
      readonly actualEndAt: LocalDate;
    };

export type ElectionPeriodTransition = TransitionResult<
  ElectionPeriodState,
  ElectionPeriodEvent["type"]
>;

/** The legal §2.3.2 transition graph. */
export const ELECTION_PERIOD_GRAPH: Readonly<
  Record<ElectionPeriodState, ReadonlyArray<ElectionPeriodEvent["type"]>>
> = {
  pending: ["signElectionStatement"],
  signed: ["setActive"],
  active: ["complete"],
  completed: [],
};

/** Recert periods (sequence ≥ 3) require an attested F2F before `setActive` (R-F2F-04, §2.4). */
export const RECERT_SEQUENCE_FLOOR = 3;

// ── the benefit-period WINDOW (42 CFR 418.21(a)) ────────────────────────────────────────────────────────
//
// A hospice election runs in benefit periods: an initial 90-day period, a second 90-day period, then an
// unlimited number of 60-day periods. The length is therefore a pure function of the period's SEQUENCE —
// which is why `election_period.period_kind` exists as an enum of exactly those two lengths.
//
// This is the source of truth the `m6.election.period_started` schema comment says the platform lacks
// ("computing real dates here would mean fabricating a period-kind-derived (90/60-day) end date the schema
// has no source of truth for"). It does not lack one: the regulation fixes the length, the sequence is
// stored, and the START is the moment the period is activated — the same `activatedAt` the caller already
// holds. The columns went unwritten because the write path stamps status directly and never ran the
// `set_timestamp` effects this machine returns, not because the dates were unknowable.

/** Days in each benefit-period kind (42 CFR 418.21(a)). */
export const ELECTION_PERIOD_LENGTH_DAYS: Readonly<Record<"ninety_day" | "sixty_day", number>> = {
  ninety_day: 90,
  sixty_day: 60,
};

/** The `election_period_kind` a sequence number takes: 1 and 2 are 90-day, every later period is 60-day. */
export function electionPeriodKindForSequence(sequenceNumber: number): "ninety_day" | "sixty_day" {
  return sequenceNumber <= 2 ? "ninety_day" : "sixty_day";
}

/**
 * The INCLUSIVE last day of a benefit period that became effective on `effectiveOn`.
 *
 * Inclusive because that is the convention every downstream consumer of a hospice benefit period already
 * uses — a 90-day period effective 2026-01-01 ends 2026-03-31, which is the date that goes on the NOE and
 * the claim, not 2026-04-01. Readers that want a half-open window add a day; `scheduled_end_at` is the
 * last covered day, and `effective_at` is the first.
 *
 * Pure UTC date math on `YYYY-MM-DD` strings (the column type), so no timezone enters the calculation.
 */
export function electionPeriodScheduledEnd(
  effectiveOn: LocalDate,
  kind: "ninety_day" | "sixty_day",
): LocalDate {
  const start = new Date(`${effectiveOn}T00:00:00.000Z`);
  const end = new Date(start.getTime() + (ELECTION_PERIOD_LENGTH_DAYS[kind] - 1) * 86_400_000);
  return end.toISOString().slice(0, 10);
}

/**
 * Apply an election-period event (§2.3.2). Throws {@link AdmissionStateError} `ILLEGAL_TRANSITION` for
 * an unaccepted event, or the specific §2.4 code on a guard failure.
 */
export function transitionElectionPeriod(
  from: ElectionPeriodState,
  event: ElectionPeriodEvent,
): ElectionPeriodTransition {
  if (!ELECTION_PERIOD_GRAPH[from].includes(event.type)) {
    throw new AdmissionStateError(
      "ILLEGAL_TRANSITION",
      `election period cannot ${event.type} from '${from}'`,
    );
  }

  switch (event.type) {
    case "signElectionStatement": {
      // R-EL-01 / R-EL-02 / R-EL-04 + the no-overlap guard (the DB GIST EXCLUDE mirror).
      checkRepresentativeAuthority({
        signerKind: event.signerKind,
        hasActiveDpoaConsent: event.hasActiveDpoaConsent,
      });
      checkNoConcurrentElection({
        existingActiveElectionElsewhere: event.existingActiveElectionElsewhere,
      });
      checkCurativeCareAck({ curativeCareAcknowledgment: event.curativeCareAcknowledgment });
      require_(
        !event.wouldOverlap,
        "ELECTION_PERIOD_OVERLAP",
        "election period would overlap an existing period",
      );
      return result(from, event.type, "signed", [
        { kind: "audit" },
        { kind: "outbox", event: "m6.election.signed" },
      ]);
    }
    case "setActive": {
      // Guard: CTI signed AND admission activated; recert (seq ≥ 3) needs an attested F2F (R-F2F-04).
      require_(event.certificationSigned, "CERTIFICATION_REQUIRED", "CTI not signed");
      require_(event.admissionActivated, "ILLEGAL_TRANSITION", "admission not yet activated");
      if (event.sequence >= RECERT_SEQUENCE_FLOOR) {
        require_(
          event.f2fAttested,
          "F2F_REQUIRED_FOR_RECERT",
          "recert period requires an attested F2F",
        );
      }
      return result(from, event.type, "active", [
        { kind: "set_timestamp", field: "effective_at", at: event.effectiveAt },
        { kind: "audit" },
        { kind: "outbox", event: "m6.election.period_started" },
        { kind: "open_window", window: "cti_signature_lookahead_14d" },
      ]);
    }
    case "complete": {
      return result(from, event.type, "completed", [
        { kind: "set_timestamp", field: "actual_end_at", at: event.actualEndAt },
        { kind: "audit" },
        { kind: "outbox", event: "m6.election.period_ended" },
      ]);
    }
  }
}
