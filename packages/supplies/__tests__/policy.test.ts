import { describe, expect, it } from "vitest";

import {
  CONTROLLED_DISCREPANCY_THRESHOLD_PCT,
  CONTROLLED_EXPIRATION_MIN_DAYS_FLOOR,
  RETURN_OVERDUE_DAYS,
  RETURN_UNRETURNABLE_DAYS_DEFAULT,
  daysBetween,
  hoursBetween,
  isControlledExpirationAcceptable,
  isReceivedConfirmAutoDue,
  isVendorConfirmationOverdue,
  returnDueAt,
  returnEscalationAt,
} from "../src/policy";

const at = (iso: string) => new Date(iso);

describe("M21 §2 policy constants", () => {
  it("pins the D8 controlled-substance discrepancy threshold at 5%", () => {
    expect(CONTROLLED_DISCREPANCY_THRESHOLD_PCT).toBe(0.05);
  });

  it("keeps the 30-day overdue boundary strictly inside the 90-day unreturnable one", () => {
    expect(RETURN_OVERDUE_DAYS).toBeLessThan(RETURN_UNRETURNABLE_DAYS_DEFAULT);
  });
});

describe("hoursBetween / daysBetween", () => {
  it("floors partial units", () => {
    expect(hoursBetween(at("2026-07-01T00:00:00Z"), at("2026-07-01T01:59:00Z"))).toBe(1);
    expect(daysBetween(at("2026-07-01T00:00:00Z"), at("2026-07-02T23:00:00Z"))).toBe(1);
  });

  it("is negative when the later instant precedes the earlier one", () => {
    expect(hoursBetween(at("2026-07-02T00:00:00Z"), at("2026-07-01T00:00:00Z"))).toBeLessThan(0);
  });
});

describe("§2.2 caregiver-confirm grace", () => {
  const delivered = at("2026-07-01T00:00:00Z");

  it("is not due before 72h", () => {
    expect(isReceivedConfirmAutoDue(delivered, at("2026-07-03T23:59:00Z"))).toBe(false);
  });

  it("is due at exactly 72h (the boundary auto-confirms)", () => {
    expect(isReceivedConfirmAutoDue(delivered, at("2026-07-04T00:00:00Z"))).toBe(true);
  });
});

describe("§2.6 return window + escalation ladder", () => {
  const required = at("2026-07-01T00:00:00Z");

  it("derives return_due_at from the default 72h window", () => {
    expect(returnDueAt(required).toISOString()).toBe("2026-07-04T00:00:00.000Z");
  });

  it("honours a tenant-tightened window", () => {
    expect(returnDueAt(required, 24).toISOString()).toBe("2026-07-02T00:00:00.000Z");
  });

  it("reports no escalation inside 30 days", () => {
    expect(returnEscalationAt(required, at("2026-07-30T00:00:00Z"))).toBe("none");
  });

  it("escalates to overdue_30d at exactly 30 days", () => {
    expect(returnEscalationAt(required, at("2026-07-31T00:00:00Z"))).toBe("overdue_30d");
  });

  it("escalates to unreturnable_90d at exactly 90 days", () => {
    expect(returnEscalationAt(required, at("2026-09-29T00:00:00Z"))).toBe("unreturnable_90d");
  });

  it("lets a tenant tighten the unreturnable boundary", () => {
    expect(returnEscalationAt(required, at("2026-08-15T00:00:00Z"), 45)).toBe("unreturnable_90d");
  });
});

describe("§3.1.9 controlled-substance expiration window", () => {
  const dispatch = at("2026-07-01T00:00:00Z");

  it("accepts an expiration exactly at the 30-day default", () => {
    expect(isControlledExpirationAcceptable(at("2026-07-31T00:00:00Z"), dispatch)).toBe(true);
  });

  it("refuses one day inside the default", () => {
    expect(isControlledExpirationAcceptable(at("2026-07-30T00:00:00Z"), dispatch)).toBe(false);
  });

  it("honours a tenant TIGHTENING to 60 days", () => {
    expect(isControlledExpirationAcceptable(at("2026-07-31T00:00:00Z"), dispatch, 60)).toBe(false);
    expect(isControlledExpirationAcceptable(at("2026-08-30T00:00:00Z"), dispatch, 60)).toBe(true);
  });

  it("clamps a mis-configured tenant value UP to the SQL floor rather than honouring it as looser", () => {
    // A tenant asking for 3 days gets the platform's 14, not a dispatch the CHECK would then refuse.
    expect(isControlledExpirationAcceptable(at("2026-07-04T00:00:00Z"), dispatch, 3)).toBe(false);
    expect(
      isControlledExpirationAcceptable(
        new Date(dispatch.getTime() + CONTROLLED_EXPIRATION_MIN_DAYS_FLOOR * 86_400_000),
        dispatch,
        3,
      ),
    ).toBe(true);
  });
});

describe("§2.10 vendor-confirmation advisory", () => {
  const ordered = at("2026-07-01T00:00:00Z");

  it("fires at the 24h default", () => {
    expect(isVendorConfirmationOverdue(ordered, at("2026-07-02T00:00:00Z"))).toBe(true);
    expect(isVendorConfirmationOverdue(ordered, at("2026-07-01T23:00:00Z"))).toBe(false);
  });

  it("clamps a loosened tenant window DOWN to the 72h ceiling", () => {
    expect(isVendorConfirmationOverdue(ordered, at("2026-07-04T00:00:00Z"), 240)).toBe(true);
  });
});
