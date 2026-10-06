// Filing a corrected NOE / NOTR after a rejection (CMS Pub. 100-04 ch. 11 §20.1.1 / §20.1.2, M23 §2.2 "corrected
// NOE is its own row"): only a rejected notice can be corrected, one correction at a time, and the correction
// copies the notice while the biller may fix the notice-owned date.
import { describe, expect, it } from "vitest";
import {
  NOTICE_CORRECTION_REASON_MAX,
  NOTICE_CORRECTION_REASON_MIN,
  correctedNoticeDates,
  planNoticeCorrection,
  validateCorrectionReason,
} from "../src/notice";

const REASON =
  "MAC rejected: the beneficiary MBI changed; refiling with the HETS-verified identifier.";

describe("planNoticeCorrection — state guards and the one-open-correction rule", () => {
  it("creates a correction for a rejected notice that has none", () => {
    expect(planNoticeCorrection({ id: "a", state: "ack_rejected" }, [])).toEqual({
      kind: "create",
    });
  });

  it.each(["draft", "ready", "submitted", "ack_pending", "ack_accepted", "cancelled"] as const)(
    "refuses a notice in state %s (only a rejected notice is refiled)",
    (state) => {
      const plan = planNoticeCorrection({ id: "a", state }, []);
      expect(plan).toMatchObject({ kind: "refuse", code: "NOTICE_NOT_REJECTED" });
    },
  );

  it.each(["draft", "ready", "submitted", "ack_pending", "ack_accepted"] as const)(
    "replays the existing %s correction instead of filing a second one (idempotent)",
    (state) => {
      const existing = { id: "b", state };
      expect(planNoticeCorrection({ id: "a", state: "ack_rejected" }, [existing])).toEqual({
        kind: "replay",
        existing,
      });
    },
  );

  it("files a new correction when the earlier one was cancelled", () => {
    expect(
      planNoticeCorrection({ id: "a", state: "ack_rejected" }, [{ id: "b", state: "cancelled" }]),
    ).toEqual({ kind: "create" });
  });

  it("refuses when the correction was itself rejected — correct the latest notice instead", () => {
    const plan = planNoticeCorrection({ id: "a", state: "ack_rejected" }, [
      { id: "b", state: "ack_rejected" },
    ]);
    expect(plan).toMatchObject({ kind: "refuse", code: "CORRECT_LATEST_NOTICE", latestId: "b" });
  });
});

describe("correctedNoticeDates — copy, edit, re-validate; the clock runs from the (corrected) date", () => {
  const today = "2026-10-06";

  it("copies the date and keeps the 5-day window when nothing is edited", () => {
    expect(correctedNoticeDates({ sourceDate: "2026-10-01", today })).toEqual({
      ok: true,
      date: "2026-10-01",
      windowTargetAt: "2026-10-06",
      changed: false,
    });
  });

  it("re-derives the window from a corrected admission / end date", () => {
    expect(
      correctedNoticeDates({ sourceDate: "2026-10-01", editedDate: "2026-09-30", today }),
    ).toEqual({ ok: true, date: "2026-09-30", windowTargetAt: "2026-10-05", changed: true });
  });

  it("refuses a malformed date", () => {
    expect(
      correctedNoticeDates({ sourceDate: "2026-10-01", editedDate: "2026-02-30", today }),
    ).toMatchObject({ ok: false, code: "INVALID_DATE" });
  });

  it("refuses a date in the future (a notice reports an event that already happened)", () => {
    expect(
      correctedNoticeDates({ sourceDate: "2026-10-01", editedDate: "2026-10-07", today }),
    ).toMatchObject({ ok: false, code: "DATE_IN_FUTURE" });
  });
});

describe("validateCorrectionReason", () => {
  it("accepts a reason within the bounds (trimmed)", () => {
    expect(validateCorrectionReason(`  ${REASON}  `)).toEqual({ ok: true, reason: REASON });
  });

  it("refuses a reason shorter than the floor", () => {
    expect(validateCorrectionReason("x".repeat(NOTICE_CORRECTION_REASON_MIN - 1))).toMatchObject({
      ok: false,
    });
  });

  it("refuses a reason longer than the ceiling", () => {
    expect(validateCorrectionReason("x".repeat(NOTICE_CORRECTION_REASON_MAX + 1))).toMatchObject({
      ok: false,
    });
  });
});
