// @wardenx/billing — filing a corrected NOE / NOTR after Medicare rejected one. PURE.
//
// A NOE or NOTR the 999 or 277CA rejected never reached the CWF: no election (or termination) was established.
// The fix is a NEW original notice (TOB 8xA / 8xB) — M23 §2.2: "corrected NOE is its own row". It is NOT the
// occurrence code 56 + condition code D0 correction of §20.1.1 / §20.1.2, which corrects a date Medicare has
// already POSTED (an accepted notice), nor the 8xD cancel of §20.1.4. The rejected row stays as history and the
// correction points back at it (`corrects_notice_id`).
//
// Rules: only a rejected notice is corrected; one correction at a time (a second request replays the one in
// progress or the accepted one); a rejected correction is corrected in turn (the chain grows from its latest
// link). The notice-owned date (NOE admission / NOTR end date) may be fixed; everything else the gateway renders
// comes from its owning module (M5 demographics, M40 provider, M6 election), which the biller fixes at the source.
// The timeliness clock is re-derived from the (corrected) date, so a refile after day 5 is late (late-noe.ts).
import type { IsoDate, NoticeState } from "../contracts";
import { toEpochDay } from "../domain/dates";
import { noticeWindowTargetAt } from "./late-noe";

export const NOTICE_CORRECTION_REASON_MIN = 20;
export const NOTICE_CORRECTION_REASON_MAX = 2000;

export interface NoticeLink {
  readonly id: string;
  readonly state: NoticeState;
}

export type NoticeCorrectionPlan =
  | { readonly kind: "create" }
  | { readonly kind: "replay"; readonly existing: NoticeLink }
  | {
      readonly kind: "refuse";
      readonly code: "NOTICE_NOT_REJECTED" | "CORRECT_LATEST_NOTICE";
      readonly message: string;
      readonly latestId?: string;
    };

/** Decide what a "file corrected notice" request does, given the source and its existing corrections. */
export function planNoticeCorrection(
  source: NoticeLink,
  corrections: readonly NoticeLink[],
): NoticeCorrectionPlan {
  if (source.state !== "ack_rejected") {
    return {
      kind: "refuse",
      code: "NOTICE_NOT_REJECTED",
      message: `only a notice Medicare rejected can be corrected (this one is '${source.state}')`,
    };
  }
  const live = corrections.find((c) => c.state !== "cancelled" && c.state !== "ack_rejected");
  if (live) return { kind: "replay", existing: live };
  const rejected = corrections.find((c) => c.state === "ack_rejected");
  if (rejected) {
    return {
      kind: "refuse",
      code: "CORRECT_LATEST_NOTICE",
      message:
        "this notice was already corrected and Medicare rejected the correction: correct that one",
      latestId: rejected.id,
    };
  }
  return { kind: "create" };
}

export type CorrectedDates =
  | {
      readonly ok: true;
      readonly date: IsoDate;
      readonly windowTargetAt: IsoDate;
      readonly changed: boolean;
    }
  | {
      readonly ok: false;
      readonly code: "INVALID_DATE" | "DATE_IN_FUTURE";
      readonly message: string;
    };

/**
 * The corrected notice's date (the NOE admission date, or the NOTR effective end date) and its 5-day due date.
 * `editedDate` absent = copy the source's.
 */
export function correctedNoticeDates(input: {
  readonly sourceDate: IsoDate;
  readonly editedDate?: string | null;
  readonly today: IsoDate;
}): CorrectedDates {
  const date = input.editedDate ?? input.sourceDate;
  let day: number;
  try {
    day = toEpochDay(date);
  } catch {
    return { ok: false, code: "INVALID_DATE", message: `'${date}' is not a calendar date` };
  }
  if (day > toEpochDay(input.today)) {
    return {
      ok: false,
      code: "DATE_IN_FUTURE",
      message: "a notice reports an admission or end of care that already happened",
    };
  }
  return {
    ok: true,
    date,
    windowTargetAt: noticeWindowTargetAt(date),
    changed: date !== input.sourceDate,
  };
}

/** The biller's why (kept on the correction row; never put in an event or alert). */
export function validateCorrectionReason(
  raw: string,
):
  | { readonly ok: true; readonly reason: string }
  | { readonly ok: false; readonly message: string } {
  const reason = raw.trim();
  if (
    reason.length < NOTICE_CORRECTION_REASON_MIN ||
    reason.length > NOTICE_CORRECTION_REASON_MAX
  ) {
    return {
      ok: false,
      message: `a correction reason of ${NOTICE_CORRECTION_REASON_MIN}–${NOTICE_CORRECTION_REASON_MAX} characters is required`,
    };
  }
  return { ok: true, reason };
}
