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
