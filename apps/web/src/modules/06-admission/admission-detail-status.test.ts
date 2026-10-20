import { describe, expect, it } from "vitest";
import { describePeriod, describeWindow, displayPatientStatus } from "./admission-detail-status";

const base = { id: "x", state: "open", version: 1 };

describe("displayPatientStatus", () => {
  it("shows an active admission's lagging prospective patient as active", () => {
    expect(displayPatientStatus("prospective", "active")).toBe("active");
    expect(displayPatientStatus("prospective", "pending")).toBe("prospective");
    expect(displayPatientStatus("discharged", "active")).toBe("discharged");
  });
});

describe("describePeriod", () => {
  it("falls back to expectedStart and TBD", () => {
    expect(describePeriod({ ...base, sequenceNumber: 2, expectedStart: "2026-01-05" })).toBe(
      "Period 2 · Jan 5, 2026 – TBD",
    );
  });
});

describe("describeWindow", () => {
  it("uses the product label for known kinds and humanizes the rest", () => {
    expect(describeWindow({ ...base, windowKind: "election_addendum_initial" })).toBe(
      "Election addendum (5 days)",
    );
    expect(describeWindow({ ...base, windowKind: "f2f_recert" })).toBe("F2f Recert");
  });
  it("leaves an unparseable due date out", () => {
    expect(describeWindow({ ...base, windowKind: "f2f_recert", dueAt: "nope" })).toBe("F2f Recert");
  });
});
