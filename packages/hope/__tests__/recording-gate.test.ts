// @chartwarden/hope — recording-boundary guards + discipline rule (§2.3, §4.7, D2/D9/D12) — M10-T03.
import { describe, expect, it } from "vitest";
import {
  assertAuthorDisciplineAllowed,
  isHopeAuthorDisciplineAllowed,
  isSfvAuthorDisciplineAllowed,
} from "../src/recording/discipline";
import {
  LATE_COMPLETION_REASON_CODES,
  assertAdmissionActiveAtTarget,
  assertCaptureAllowed,
  assertRfaMatchesSchedule,
  assertSectionQForDischarge,
  captureInstantOf,
} from "../src/recording/timepoint-gate";
import { windowFor } from "../src/scheduling/window-calculator";

const UTC = "UTC";
const w = windowFor("01_admission", "2026-06-01", UTC); // close 06-05, late 06-12

describe("assertAdmissionActiveAtTarget", () => {
  it("passes when active", () => {
    expect(() => assertAdmissionActiveAtTarget(true)).not.toThrow();
  });
  it("rejects an inactive admission (409 M10_ADMISSION_NOT_ACTIVE)", () => {
    expect(() => assertAdmissionActiveAtTarget(false)).toThrowError(
      expect.objectContaining({ code: "M10_ADMISSION_NOT_ACTIVE", statusCode: 409 }),
    );
  });
});

describe("assertRfaMatchesSchedule", () => {
  it("passes on an exact match", () => {
    expect(() =>
      assertRfaMatchesSchedule("02_huv1", { rfaKind: "02_huv1", generatedBy: "auto_admission" }),
    ).not.toThrow();
  });
  it("allows a 04_sfv payload against an sfv_trigger schedule", () => {
    expect(() =>
      assertRfaMatchesSchedule("04_sfv", { rfaKind: "04_sfv", generatedBy: "sfv_trigger" }),
    ).not.toThrow();
  });
  it("rejects a mismatch (409 M10_RFA_KIND_MISMATCH)", () => {
    expect(() =>
      assertRfaMatchesSchedule("03_huv2", { rfaKind: "02_huv1", generatedBy: "auto_admission" }),
    ).toThrowError(expect.objectContaining({ code: "M10_RFA_KIND_MISMATCH", statusCode: 409 }));
  });
});

describe("assertCaptureAllowed — D2/D12 soft-window + late-reason gate", () => {
  it("in-window capture is not late and drops any sent late reason", () => {
    expect(assertCaptureAllowed("2026-06-03T12:00:00.000Z", w)).toEqual({
      wasLate: false,
      lateReasonCode: null,
    });
  });
  it("rejects a before-open capture (409 M10_TIMEPOINT_NOT_OPEN)", () => {
    expect(() => assertCaptureAllowed("2026-05-30T12:00:00.000Z", w)).toThrowError(
      expect.objectContaining({ code: "M10_TIMEPOINT_NOT_OPEN", statusCode: 409 }),
    );
  });
  it("rejects a past-deadline capture (409 M10_TIMEPOINT_EXPIRED)", () => {
    expect(() => assertCaptureAllowed("2026-06-20T12:00:00.000Z", w)).toThrowError(
      expect.objectContaining({ code: "M10_TIMEPOINT_EXPIRED", statusCode: 409 }),
    );
  });
  it("allows a past-deadline capture WITH an admin override (then requires a late reason)", () => {
    expect(
      assertCaptureAllowed("2026-06-20T12:00:00.000Z", w, {
        adminOverride: true,
        lateReasonCode: "pto",
      }),
    ).toEqual({ wasLate: true, lateReasonCode: "pto" });
  });
  it("late capture requires a late reason (400 M10_LATE_REASON_REQUIRED)", () => {
    expect(() => assertCaptureAllowed("2026-06-09T12:00:00.000Z", w)).toThrowError(
      expect.objectContaining({ code: "M10_LATE_REASON_REQUIRED", statusCode: 400 }),
    );
  });
  it("late capture rejects an off-list reason (400 M10_LATE_REASON_INVALID)", () => {
    expect(() =>
      assertCaptureAllowed("2026-06-09T12:00:00.000Z", w, { lateReasonCode: "because" }),
    ).toThrowError(expect.objectContaining({ code: "M10_LATE_REASON_INVALID", statusCode: 400 }));
  });
  it("late capture accepts a valid CMS reason", () => {
    expect(
      assertCaptureAllowed("2026-06-09T12:00:00.000Z", w, { lateReasonCode: "hospitalization" }),
    ).toEqual({ wasLate: true, lateReasonCode: "hospitalization" });
    expect(LATE_COMPLETION_REASON_CODES).toContain("hospitalization");
  });
});

describe("assertCaptureAllowed — GAP-015 server-time judgement", () => {
  it("a late filer cannot dodge the hard cutoff with an in-window targetDate", () => {
    // targetDate 06-03 is in-window, but the write happens 06-20 (past the deadline): expired.
    expect(() =>
      assertCaptureAllowed("2026-06-03T12:00:00.000Z", w, { nowIso: "2026-06-20T12:00:00.000Z" }),
    ).toThrowError(expect.objectContaining({ code: "M10_TIMEPOINT_EXPIRED", statusCode: 409 }));
  });
  it("a late filer cannot get was_late=false with an in-window targetDate", () => {
    // written in the grace span (06-09): late, so the typed reason is mandatory, whatever targetDate says.
    expect(() =>
      assertCaptureAllowed("2026-06-03T12:00:00.000Z", w, { nowIso: "2026-06-09T12:00:00.000Z" }),
    ).toThrowError(expect.objectContaining({ code: "M10_LATE_REASON_REQUIRED" }));
    expect(
      assertCaptureAllowed("2026-06-03T12:00:00.000Z", w, {
        nowIso: "2026-06-09T12:00:00.000Z",
        lateReasonCode: "pto",
      }),
    ).toEqual({ wasLate: true, lateReasonCode: "pto" });
  });
  it("a capture written inside the window stays on time; a backdated-before-open date is still refused", () => {
    expect(
      assertCaptureAllowed("2026-06-03T12:00:00.000Z", w, { nowIso: "2026-06-04T12:00:00.000Z" }),
    ).toEqual({ wasLate: false, lateReasonCode: null });
    expect(() =>
      assertCaptureAllowed("2026-05-30T12:00:00.000Z", w, { nowIso: "2026-06-04T12:00:00.000Z" }),
    ).toThrowError(expect.objectContaining({ code: "M10_TIMEPOINT_NOT_OPEN" }));
  });
  it("captureInstantOf is the later of the two instants", () => {
    expect(captureInstantOf("2026-06-03T00:00:00.000Z", "2026-06-09T00:00:00.000Z")).toBe(
      "2026-06-09T00:00:00.000Z",
    );
    expect(captureInstantOf("2026-06-09T00:00:00.000Z", "2026-06-03T00:00:00.000Z")).toBe(
      "2026-06-09T00:00:00.000Z",
    );
  });
});

describe("assertSectionQForDischarge — D9 reason branch", () => {
  it("death-discharge rejects Section Q (400 M10_FORBIDDEN_SECTION_PRESENT)", () => {
    expect(() => assertSectionQForDischarge("death", true)).toThrowError(
      expect.objectContaining({ code: "M10_FORBIDDEN_SECTION_PRESENT", statusCode: 400 }),
    );
    expect(() => assertSectionQForDischarge("death", false)).not.toThrow();
  });
  it("live-discharge requires Section Q (400 M10_REQUIRED_SECTION_MISSING)", () => {
    expect(() => assertSectionQForDischarge("live_discharge", false)).toThrowError(
      expect.objectContaining({ code: "M10_REQUIRED_SECTION_MISSING", statusCode: 400 }),
    );
    expect(() => assertSectionQForDischarge("live_discharge", true)).not.toThrow();
  });
  it("revocation and transfer also require Section Q (D9)", () => {
    expect(() => assertSectionQForDischarge("revocation", true)).not.toThrow();
    expect(() => assertSectionQForDischarge("transfer_to_hospice", false)).toThrowError(
      expect.objectContaining({ code: "M10_REQUIRED_SECTION_MISSING" }),
    );
  });
});

describe("author-discipline rule (§4.7, RN/NP-only author rule)", () => {
  it("RN/NP/MD may author a HOPE timepoint; others may not", () => {
    expect(isHopeAuthorDisciplineAllowed("RN")).toBe(true);
    expect(isHopeAuthorDisciplineAllowed("MD")).toBe(true);
    expect(isHopeAuthorDisciplineAllowed("LPN")).toBe(false);
  });
  it("only RN/NP/LPN/LVN may author an SFV (CMS HOPE Guidance Manual v1.03)", () => {
    for (const d of ["RN", "NP", "LPN", "LVN"]) expect(isSfvAuthorDisciplineAllowed(d)).toBe(true);
    for (const d of ["MD", "SW", "CHAPLAIN", "AIDE", "lpn", ""])
      expect(isSfvAuthorDisciplineAllowed(d)).toBe(false);
  });
  it("LPN/LVN stay excluded from the non-SFV timepoints (rule unchanged)", () => {
    expect(isHopeAuthorDisciplineAllowed("LVN")).toBe(false);
    expect(() => assertAuthorDisciplineAllowed("01_admission", "LPN")).toThrowError(
      expect.objectContaining({ code: "M10_DISCIPLINE_NOT_PERMITTED", statusCode: 403 }),
    );
  });
  it("service guard and ABAC data agree for an LPN SFV", () => {
    expect(() => assertAuthorDisciplineAllowed("04_sfv", "LPN")).not.toThrow();
    expect(() => assertAuthorDisciplineAllowed("04_sfv", "LVN")).not.toThrow();
    expect(() => assertAuthorDisciplineAllowed("04_sfv", "SW")).toThrowError(
      expect.objectContaining({ code: "M10_DISCIPLINE_NOT_PERMITTED" }),
    );
  });
  it("assertAuthorDisciplineAllowed branches on rfa_kind (403 M10_DISCIPLINE_NOT_PERMITTED)", () => {
    expect(() => assertAuthorDisciplineAllowed("01_admission", "MD")).not.toThrow();
    expect(() => assertAuthorDisciplineAllowed("04_sfv", "MD")).toThrowError(
      expect.objectContaining({ code: "M10_DISCIPLINE_NOT_PERMITTED", statusCode: 403 }),
    );
    expect(() => assertAuthorDisciplineAllowed("01_admission", "SW")).toThrowError(
      expect.objectContaining({ code: "M10_DISCIPLINE_NOT_PERMITTED", statusCode: 403 }),
    );
  });
});
