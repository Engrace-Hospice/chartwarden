// @chartwarden/billing — NOE timeliness and the late-NOE occurrence span 77 (M23-F05). PURE.
//
// CMS Pub. 100-04 ch. 11 §20.1.1 (Rev. 12847): "A timely-filed NOE is a NOE that is submitted to the A/B MAC (HHH)
// and accepted by the A/B MAC (HHH) within 5 calendar days after the hospice admission date. … In instances where
// a NOE is not timely-filed, Medicare shall not cover and pay for the days of hospice care from the hospice
// admission date to the date the NOE is submitted to, and accepted by, the A/B MAC (HHH). These days shall be a
// provider liability … The hospice shall report these non-covered days on the claim with an occurrence span
// code 77". The span therefore runs from the admission date through the day BEFORE the acceptance date (the day
// of acceptance is covered), and each claim reports only the part of it inside its own service period.
//
// The clock always runs from the admission date: a corrected NOE filed after a rejection inherits it, so a
// rejection that is refiled after day 5 makes the NOE late. The CMS exceptions to the late-filing consequences
// (§20.1.1's four circumstances, granted by the MAC on request) are not modelled here.
import type { IsoDate } from "../contracts";
import { addDaysIso, maxIso, minIso, toEpochDay } from "../domain/dates";

/** §20.1.1 — the NOE and NOTR are timely within this many calendar days after the admission / end date. */
export const NOTICE_FILING_WINDOW_DAYS = 5;

/** The UB-04 occurrence span code for late-NOE provider-liable days. */
export const LATE_NOE_OCCURRENCE_SPAN_CODE = "77";

/** A UB-04 FL 35-36 / 837I `HI*BI` occurrence span (both dates inclusive). */
export interface OccurrenceSpan {
  readonly code: string;
  readonly from: IsoDate;
  readonly through: IsoDate;
}

/** The notice's due date: `date + 5` calendar days (the `window_target_at` column). */
export function noticeWindowTargetAt(date: IsoDate): IsoDate {
  return addDaysIso(date, NOTICE_FILING_WINDOW_DAYS);
}

export interface NoeTimeliness {
  readonly status: "timely" | "late" | "unknown";
  readonly dueDate: IsoDate;
  /** Calendar days past the due date; 0 when timely; null when unknown. */
  readonly daysLate: number | null;
}

/** Was the NOE accepted by the MAC within 5 calendar days after admission? `unknown` until it is accepted. */
export function noeTimeliness(input: {
  readonly admissionDate: IsoDate;
  readonly acceptedDate: IsoDate | null;
}): NoeTimeliness {
  const dueDate = noticeWindowTargetAt(input.admissionDate);
  if (input.acceptedDate === null) return { status: "unknown", dueDate, daysLate: null };
  const daysLate = toEpochDay(input.acceptedDate) - toEpochDay(dueDate);
  return daysLate > 0
    ? { status: "late", dueDate, daysLate }
    : { status: "timely", dueDate, daysLate: 0 };
}

/**
 * The OSC 77 span this claim must report, or null when the NOE was timely, its acceptance date is not known, or
 * none of the liable days fall inside the claim's service period.
 */
export function lateNoeOccurrenceSpan(input: {
  readonly admissionDate: IsoDate;
  readonly acceptedDate: IsoDate | null;
  readonly serviceFrom: IsoDate;
  readonly serviceTo: IsoDate;
}): OccurrenceSpan | null {
  const timeliness = noeTimeliness(input);
  if (timeliness.status !== "late" || input.acceptedDate === null) return null;
  const liableThrough = addDaysIso(input.acceptedDate, -1);
  const from = maxIso(input.admissionDate, input.serviceFrom);
  const through = minIso(liableThrough, input.serviceTo);
  if (toEpochDay(from) > toEpochDay(through)) return null;
  return { code: LATE_NOE_OCCURRENCE_SPAN_CODE, from, through };
}

/**
 * The occurrence spans a claim must carry for its admission's effective NOE: the OSC 77 span when that NOE was
 * accepted late and some liable days fall in the claim period, else none (an unaccepted NOE has no acceptance
 * date yet — the `noe_timeliness_5d` rule blocks or warns on it instead).
 */
export function claimLateNoeSpans(
  noe:
    | {
        readonly state: string;
        readonly electionEffectiveDate: IsoDate;
        readonly acceptedDate: IsoDate | null;
      }
    | null
    | undefined,
  claim: { readonly serviceFrom: IsoDate; readonly serviceTo: IsoDate },
): OccurrenceSpan[] {
  if (!noe || noe.state !== "ack_accepted") return [];
  const span = lateNoeOccurrenceSpan({
    admissionDate: noe.electionEffectiveDate,
    acceptedDate: noe.acceptedDate,
    serviceFrom: claim.serviceFrom,
    serviceTo: claim.serviceTo,
  });
  return span ? [span] : [];
}
