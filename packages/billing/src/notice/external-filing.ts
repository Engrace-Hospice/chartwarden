// @chartwarden/billing — a tenant that bills outside ChartWarden files its NOE / NOTR itself (owner decision D4). PURE.
//
// ChartWarden transmits nothing for such a tenant but keeps counting the notice's CMS window (`window_target_at`) until the
// tenant records the date it filed. This decides what that record does: the notice must still be waiting to be filed (draft /
// ready: ChartWarden never submitted it and Medicare has not answered), the date is a real calendar day, not in the future and
// not before the notice's earliest date (the NOE election effective date / the NOTR end date, the DDE-acceptance rule), a re-record
// of the same date changes nothing, and a date past the due date stamps the breach on record (the watchdog never will: a notice
// recorded as filed leaves its scan). A breach the watchdog already stamped is what ChartWarden OBSERVED: a tenant's record never
// clears it, even an on-time one (the filing date is only the tenant's word, not Medicare's answer). Such a record is flagged
// `contradictsBreach` so the caller can put both facts (the observed breach, the attested date) in front of compliance and ops.
// A late filing is flagged `late` so the caller can announce it.
import type { IsoDate, NoticeState } from "../contracts";
import { toEpochDay } from "../domain/dates";

/** `pending`: parked for the tenant to file. `filed`: the tenant recorded the date it filed. */
export type ExternalFilingStatus = "pending" | "filed";

/** The states a notice may be in while its filing is the tenant's: ChartWarden has not submitted it, Medicare has not answered. */
export const EXTERNALLY_FILEABLE_STATES: readonly NoticeState[] = ["draft", "ready"];

export type ExternalFilingRefusalCode =
  | "NOTICE_STATE_NOT_FILEABLE"
  | "NOTICE_ALREADY_FILED_EXTERNALLY"
  | "INVALID_DATE"
  | "FILED_ON_IN_FUTURE"
  | "FILED_ON_BEFORE_EFFECTIVE_DATE";

export type ExternalFilingPlan =
  | {
      readonly kind: "record";
      /** Filed after the due date and the watchdog stamped nothing yet: stamp the breach on record (the filing date). */
      readonly stampBreach: boolean;
      /**
       * Filed ON TIME but the watchdog already stamped a breach before it was recorded: the stamp STAYS (ChartWarden observed it),
       * and the caller announces the contradiction (the observed breach date next to the attested filing date).
       */
      readonly contradictsBreach: boolean;
      /** Filed after the due date: the late-filing event fires (once: a replay never reaches here). */
      readonly late: boolean;
    }
  | { readonly kind: "replay" }
  | {
      readonly kind: "refuse";
      readonly code: ExternalFilingRefusalCode;
      readonly status: 409 | 422;
      readonly message: string;
    };

export interface ExternalFilingRecordInput {
  readonly state: NoticeState;
  readonly externalFilingStatus: ExternalFilingStatus | null;
  readonly filedExternallyOn: IsoDate | null;
  /** The earliest date a filing can carry: the NOE election effective date / the NOTR effective end date. */
  readonly earliestDate: IsoDate;
  readonly windowTargetAt: IsoDate;
  readonly windowBreachedAt: IsoDate | null;
  /** The date the tenant says it filed. */
  readonly filedOn: string;
  /** The Eastern calendar day now (see `medicareReceiptDay`). */
  readonly today: IsoDate;
}

const refuse = (
  code: ExternalFilingRefusalCode,
  status: 409 | 422,
  message: string,
): ExternalFilingPlan => ({ kind: "refuse", code, status, message });

export function planExternalFilingRecord(input: ExternalFilingRecordInput): ExternalFilingPlan {
  if (input.externalFilingStatus === "filed") {
    return input.filedExternallyOn === input.filedOn
      ? { kind: "replay" }
      : refuse(
          "NOTICE_ALREADY_FILED_EXTERNALLY",
          409,
          "this notice is already recorded as filed on a different date",
        );
  }
  if (!EXTERNALLY_FILEABLE_STATES.includes(input.state)) {
    return refuse(
      "NOTICE_STATE_NOT_FILEABLE",
      409,
      `a notice in state '${input.state}' was already settled by ChartWarden or Medicare`,
    );
  }
  let filedDay: number;
  try {
    filedDay = toEpochDay(input.filedOn);
  } catch {
    return refuse("INVALID_DATE", 422, `'${input.filedOn}' is not a calendar date`);
  }
  if (filedDay > toEpochDay(input.today)) {
    return refuse("FILED_ON_IN_FUTURE", 422, "a filing date cannot be in the future");
  }
  if (filedDay < toEpochDay(input.earliestDate)) {
    return refuse(
      "FILED_ON_BEFORE_EFFECTIVE_DATE",
      422,
      `the notice cannot have been filed before ${input.earliestDate}`,
    );
  }
  const late = filedDay > toEpochDay(input.windowTargetAt);
  return {
    kind: "record",
    stampBreach: input.windowBreachedAt === null && late,
    contradictsBreach: input.windowBreachedAt !== null && !late,
    late,
  };
}

export type ExternalFilingWithdrawalRefusalCode =
  | "NOTICE_NOT_FILED_EXTERNALLY"
  | "NOTICE_FILING_RECORD_CHANGED";

export type ExternalFilingWithdrawalPlan =
  | {
      readonly kind: "withdraw";
      /** The filed date the withdrawn record carried (the platform audit row names it). */
      readonly withdrawnFiledOn: IsoDate;
      /**
       * The breach stamp on the notice was written by the withdrawn record itself (a LATE record stamps `windowBreachedAt = filedOn`):
       * the caller clears it with the record. A stamp the watchdog wrote stays.
       */
      readonly clearBreach: boolean;
    }
  | {
      readonly kind: "refuse";
      readonly code: ExternalFilingWithdrawalRefusalCode;
      readonly status: 409;
      readonly message: string;
    };

export interface ExternalFilingWithdrawalInput {
  readonly externalFilingStatus: ExternalFilingStatus | null;
  readonly filedExternallyOn: IsoDate | null;
  /** When the tenant recorded the filing (UTC ISO instant), the identity of the record the operator read. */
  readonly filedExternallyRecordedAt: string | null;
  /** The `recordedAt` the operator read (the route's `If-Match`). */
  readonly expectedRecordedAt: string;
  readonly windowTargetAt: IsoDate;
  readonly windowBreachedAt: IsoDate | null;
}

/**
 * A platform operator withdraws a tenant's "filed outside ChartWarden" record: the one way back from `filed` (the tenant cannot,
 * and a cancel refuses). It applies to the record the operator READ or to nothing: a record withdrawn and re-recorded since has a
 * new `recordedAt`, and withdrawing that one unseen is a 409. PURE: the caller clears the marker and the three filed columns
 * together (the table's CHECK moves them as one). A breach stamp the watchdog wrote stays (what ChartWarden observed); one the
 * withdrawn LATE record wrote itself (`stampBreach`: the stamp IS its filed date, and that date is after the due day) goes with
 * it, or re-recording the true on-time date would read as contradicting a breach nobody observed, and the stamp would hide the
 * notice from the window watch for good. A notice that really is overdue is re-stamped by that watch on its next tick.
 */
export function planExternalFilingWithdrawal(
  input: ExternalFilingWithdrawalInput,
): ExternalFilingWithdrawalPlan {
  if (
    input.externalFilingStatus !== "filed" ||
    input.filedExternallyOn === null ||
    input.filedExternallyRecordedAt === null
  ) {
    return {
      kind: "refuse",
      code: "NOTICE_NOT_FILED_EXTERNALLY",
      status: 409,
      message:
        "this notice is not recorded as filed outside ChartWarden: there is nothing to withdraw",
    };
  }
  if (input.filedExternallyRecordedAt !== input.expectedRecordedAt) {
    return {
      kind: "refuse",
      code: "NOTICE_FILING_RECORD_CHANGED",
      status: 409,
      message:
        "the filing record changed since it was read; read the notice again and withdraw the record it now shows",
    };
  }
  const wroteItsOwnBreach =
    input.windowBreachedAt === input.filedExternallyOn &&
    toEpochDay(input.filedExternallyOn) > toEpochDay(input.windowTargetAt);
  return {
    kind: "withdraw",
    withdrawnFiledOn: input.filedExternallyOn,
    clearBreach: wroteItsOwnBreach,
  };
}
