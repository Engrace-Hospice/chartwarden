// GAP-013 — the late-entry tier is COMPUTED from service_date vs the org-local day, and the reason /
// override gates read that computed tier (they were dead code: nothing ever computed a tier, so every
// encounter signed as 'normal' however late).
import { describe, expect, it } from "vitest";
import { resolveLateEntry } from "../src/modules/08-encounters/late-entry/resolve";

const base = {
  serviceDate: "2026-06-20" as never,
  persistedReason: null,
  suppliedReason: null,
  significantOverridePresent: false,
  administrativeOverridePresent: false,
};
const REASON = "Documentation delayed because the device was offline during the visit";

describe("GAP-013 — resolveLateEntry", () => {
  it("same day and next day are normal with no reason needed", () => {
    expect(
      resolveLateEntry({ ...base, asOfDate: "2026-06-20" as never, requireOverride: true }),
    ).toMatchObject({ tier: "normal", daysLate: 0 });
    expect(
      resolveLateEntry({ ...base, asOfDate: "2026-06-21" as never, requireOverride: true }),
    ).toMatchObject({ tier: "normal", daysLate: 1 });
  });

  it("2-3 days late is late_entry and needs a >= 40 char reason (422 LATE_ENTRY_REASON_REQUIRED)", () => {
    const input = { ...base, asOfDate: "2026-06-23" as never, requireOverride: true };
    expect(() => resolveLateEntry(input)).toThrowError(
      expect.objectContaining({ code: "LATE_ENTRY_REASON_REQUIRED", statusCode: 422 }),
    );
    expect(() => resolveLateEntry({ ...input, suppliedReason: "too short" })).toThrowError(
      expect.objectContaining({ code: "LATE_ENTRY_REASON_REQUIRED" }),
    );
    expect(resolveLateEntry({ ...input, suppliedReason: REASON })).toMatchObject({
      tier: "late_entry",
      daysLate: 3,
      reason: REASON,
    });
    // a reason given at finalize still counts at sign
    expect(resolveLateEntry({ ...input, persistedReason: REASON }).tier).toBe("late_entry");
  });

  it("5 days late is significant: reason AND a Clinical Supervisor override before sign", () => {
    const input = {
      ...base,
      asOfDate: "2026-06-25" as never,
      requireOverride: true,
      suppliedReason: REASON,
    };
    expect(() => resolveLateEntry(input)).toThrowError(
      expect.objectContaining({ code: "SIGNIFICANT_LATE_ENTRY_OVERRIDE_REQUIRED" }),
    );
    expect(resolveLateEntry({ ...input, significantOverridePresent: true })).toMatchObject({
      tier: "significant_late_entry",
      daysLate: 5,
    });
  });

  it("20 days late is administrative: a significant override does not satisfy it", () => {
    const input = {
      ...base,
      asOfDate: "2026-07-10" as never,
      requireOverride: true,
      suppliedReason: REASON,
      significantOverridePresent: true,
    };
    expect(() => resolveLateEntry(input)).toThrowError(
      expect.objectContaining({ code: "ADMINISTRATIVE_LATE_OVERRIDE_REQUIRED" }),
    );
    expect(resolveLateEntry({ ...input, administrativeOverridePresent: true })).toMatchObject({
      tier: "administrative_override",
      daysLate: 20,
    });
  });

  it("finalize (requireOverride=false) enforces the reason but not the override", () => {
    const input = {
      ...base,
      asOfDate: "2026-07-10" as never,
      requireOverride: false,
      suppliedReason: REASON,
    };
    expect(resolveLateEntry(input).tier).toBe("administrative_override");
    expect(() => resolveLateEntry({ ...input, suppliedReason: null })).toThrowError(
      expect.objectContaining({ code: "LATE_ENTRY_REASON_REQUIRED" }),
    );
  });
});
