// GAP-173 — the pure §4.3 BAA-expiration planner (90 / 30 / 0-day windows, idempotent keys).
import { describe, expect, it } from "vitest";
import {
  type BaaScanRecord,
  daysUntil,
  planBaaExpiryAlerts,
  windowFor,
} from "../src/jobs/baa-scan";

const TODAY = "2026-10-06";

function record(overrides: Partial<BaaScanRecord> = {}): BaaScanRecord {
  return {
    id: "baa-1",
    organizationId: "org-1",
    entityKind: "facility",
    canonicalId: "fac-1",
    baaStatus: "executed",
    expiresOn: "2027-12-31",
    ...overrides,
  };
}

describe("daysUntil / windowFor", () => {
  it("counts whole UTC calendar days, negative once past", () => {
    expect(daysUntil("2026-10-06", TODAY)).toBe(0);
    expect(daysUntil("2026-10-07", TODAY)).toBe(1);
    expect(daysUntil("2026-10-05", TODAY)).toBe(-1);
  });

  it("maps the 90/30/0-day boundaries to the most urgent window reached", () => {
    expect(windowFor(91)).toBeNull();
    expect(windowFor(90)).toBe("90_days");
    expect(windowFor(31)).toBe("90_days");
    expect(windowFor(30)).toBe("30_days");
    expect(windowFor(1)).toBe("30_days");
    expect(windowFor(0)).toBe("expired");
    expect(windowFor(-40)).toBe("expired");
  });

  it("rejects an unparsable date rather than silently skipping the record", () => {
    expect(() => daysUntil("not-a-date", TODAY)).toThrow(/MDM_BAA_SCAN_BAD_DATE/);
  });
});

describe("planBaaExpiryAlerts", () => {
  it("plans one alert per record at its most urgent window, with severity escalating", () => {
    const plans = planBaaExpiryAlerts(
      [
        record({ id: "a", expiresOn: "2027-01-01" }), // 87 days -> 90_days / info
        record({ id: "b", expiresOn: "2026-10-20" }), // 14 days -> 30_days / warn
        record({ id: "c", expiresOn: "2026-10-06" }), // today   -> expired / critical
      ],
      TODAY,
    );
    expect(plans.map((p) => [p.baaRecordId, p.window, p.severity])).toEqual([
      ["a", "90_days", "info"],
      ["b", "30_days", "warn"],
      ["c", "expired", "critical"],
    ]);
  });

  it("keys each plan on (record, window) so a daily re-scan is a no-op at the emitter", () => {
    const [first] = planBaaExpiryAlerts([record({ expiresOn: "2026-10-20" })], TODAY);
    const [again] = planBaaExpiryAlerts([record({ expiresOn: "2026-10-20" })], "2026-10-07");
    expect(first?.correlationId).toBe(again?.correlationId);
    const [escalated] = planBaaExpiryAlerts([record({ expiresOn: "2026-10-20" })], "2026-10-20");
    expect(escalated?.correlationId).not.toBe(first?.correlationId);
  });

  it("skips records that are not executed, have no expiry, or are beyond 90 days", () => {
    const plans = planBaaExpiryAlerts(
      [
        record({ id: "pending", baaStatus: "pending", expiresOn: "2026-10-10" }),
        record({ id: "n_a", baaStatus: "n_a", expiresOn: "2026-10-10" }),
        record({ id: "open-ended", expiresOn: null }),
        record({ id: "far", expiresOn: "2027-06-01" }),
      ],
      TODAY,
    );
    expect(plans).toEqual([]);
  });
});
