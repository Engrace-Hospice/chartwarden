// @chartwarden/hope — timepoint window calculator (§2.2.1, §2.3, D2) — M10-T03.
import { describe, expect, it } from "vitest";
import {
  ADMISSION_ANCHORED_WINDOWS,
  DEFAULT_LATE_GRACE_DAYS,
  DISCHARGE_WINDOW_DAYS,
  classifyCapture,
  dischargeWindow,
  windowFor,
} from "../src/scheduling/window-calculator";

const UTC = "UTC";

describe("windowFor — admission-anchored CMS HOPE windows (SOC day 1)", () => {
  it("Admission RFA spans days 1–5 from the anchor (opens 00:00 day 1, closes 23:59 day 5)", () => {
    const w = windowFor("01_admission", "2026-06-01", UTC);
    expect(w.windowOpensAt).toBe("2026-06-01T00:00:00.000Z");
    expect(w.windowClosesAt).toBe("2026-06-05T23:59:59.999Z");
    // late deadline = close + 7-day grace
    expect(w.lateDeadlineAt).toBe("2026-06-12T23:59:59.999Z");
  });

  it("HUV1 spans days 6–15; HUV2 spans days 16–30", () => {
    const huv1 = windowFor("02_huv1", "2026-06-01", UTC);
    expect(huv1.windowOpensAt).toBe("2026-06-06T00:00:00.000Z");
    expect(huv1.windowClosesAt).toBe("2026-06-15T23:59:59.999Z");
    const huv2 = windowFor("03_huv2", "2026-06-01", UTC);
    expect(huv2.windowOpensAt).toBe("2026-06-16T00:00:00.000Z");
    expect(huv2.windowClosesAt).toBe("2026-06-30T23:59:59.999Z");
  });

  it("honors a custom grace span", () => {
    const w = windowFor("01_admission", "2026-06-01", UTC, 0);
    expect(w.lateDeadlineAt).toBe(w.windowClosesAt);
  });

  it("resolves the zone offset for a non-UTC timezone (LA is UTC−7 in June)", () => {
    const w = windowFor("01_admission", "2026-06-01", "America/Los_Angeles");
    // 00:00 LA on Jun 1 == 07:00 UTC
    expect(w.windowOpensAt).toBe("2026-06-01T07:00:00.000Z");
  });

  it("exposes the day-offset spec for the three admission-anchored RFAs", () => {
    expect(ADMISSION_ANCHORED_WINDOWS["01_admission"]).toEqual({
      openDayOffset: 0,
      closeDayOffset: 4,
    });
    expect(DEFAULT_LATE_GRACE_DAYS).toBe(7);
  });
});

describe("dischargeWindow — 7-day window from discharge date (D9)", () => {
  it("opens at discharge date, closes after a 7-calendar-day span", () => {
    const w = dischargeWindow("2026-06-20", UTC);
    expect(DISCHARGE_WINDOW_DAYS).toBe(7);
    expect(w.windowOpensAt).toBe("2026-06-20T00:00:00.000Z");
    expect(w.windowClosesAt).toBe("2026-06-26T23:59:59.999Z");
  });
});

describe("classifyCapture — soft-window + hard-cutoff (D2)", () => {
  const w = windowFor("01_admission", "2026-06-01", UTC); // close 06-05, late 06-12

  it("before_open when target precedes the window", () => {
    expect(classifyCapture("2026-05-31T12:00:00.000Z", w)).toBe("before_open");
  });
  it("in_window inside the soft window (the §7.1 day-3 capture)", () => {
    expect(classifyCapture("2026-06-03T12:00:00.000Z", w)).toBe("in_window");
  });
  it("in_window exactly at the close boundary", () => {
    expect(classifyCapture("2026-06-05T23:59:59.999Z", w)).toBe("in_window");
  });
  it("late between close and late deadline", () => {
    expect(classifyCapture("2026-06-09T12:00:00.000Z", w)).toBe("late");
  });
  it("expired past the late deadline", () => {
    expect(classifyCapture("2026-06-13T00:00:00.000Z", w)).toBe("expired");
  });
});
