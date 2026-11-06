// Slice 2 (tenant pricing) — the pure helpers around the statement: calendar months and the finalize grace, the contract end date,
// who counts as staff, the operator-typed text screen, and the strict (no-coercion) request parse.
import { ChartWardenError } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import { addMonthsIso } from "../pricing/contract-service";
import type { PricingPlanView } from "../pricing/plan-service";
import { buildPricePreview } from "../pricing/preview";
import { PricePreviewBody, parseStrict } from "../pricing/pricing-typebox";
import { isNonStaffRole } from "../pricing/staff-meter";
import {
  STATEMENT_FINALIZE_GRACE_DAYS,
  calendarMonthOf,
  isFinalizable,
  previousCalendarMonth,
} from "../pricing/statement-service";
import { normalizeOptionalRef, normalizeReason } from "../pricing/text";

describe("calendarMonthOf / previousCalendarMonth", () => {
  it("is the UTC calendar month containing the instant, with its key and day count", () => {
    const m = calendarMonthOf(new Date("2026-02-14T23:59:59Z"));
    expect(m.key).toBe("2026-02");
    expect(m.start.toISOString()).toBe("2026-02-01T00:00:00.000Z");
    expect(m.end.toISOString()).toBe("2026-03-01T00:00:00.000Z");
    expect(m.days).toBe(28);
    expect(calendarMonthOf(new Date("2028-02-01T00:00:00Z")).days).toBe(29); // leap year
  });

  it("is UTC, not local: the last second of a month stays in it", () => {
    expect(calendarMonthOf(new Date("2026-12-31T23:59:59.999Z")).key).toBe("2026-12");
    expect(calendarMonthOf(new Date("2027-01-01T00:00:00.000Z")).key).toBe("2027-01");
  });

  it("walks back across a year boundary", () => {
    expect(previousCalendarMonth(calendarMonthOf(new Date("2027-01-10T00:00:00Z"))).key).toBe(
      "2026-12",
    );
  });
});

describe("isFinalizable: a month closes only after its grace", () => {
  const month = calendarMonthOf(new Date("2026-10-15T00:00:00Z"));
  const day = 86_400_000;

  it("stays a draft through the grace window, then finalizes", () => {
    expect(STATEMENT_FINALIZE_GRACE_DAYS).toBeGreaterThan(0);
    const end = month.end.getTime();
    expect(isFinalizable(month, new Date(end - 1))).toBe(false);
    expect(isFinalizable(month, new Date(end))).toBe(false); // midnight is too early: an 835 dated the 31st arrives on the 2nd
    expect(isFinalizable(month, new Date(end + STATEMENT_FINALIZE_GRACE_DAYS * day - 1))).toBe(
      false,
    );
    expect(isFinalizable(month, new Date(end + STATEMENT_FINALIZE_GRACE_DAYS * day))).toBe(true);
  });
});

describe("addMonthsIso", () => {
  it("adds calendar months on the same day", () => {
    expect(addMonthsIso("2026-11-05", 12)).toBe("2027-11-05");
    expect(addMonthsIso("2026-11-05", 36)).toBe("2029-11-05");
  });

  it("clamps to the last day of a shorter month", () => {
    expect(addMonthsIso("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonthsIso("2027-01-31", 1)).toBe("2027-02-28");
    expect(addMonthsIso("2027-12-31", 2)).toBe("2028-02-29");
  });
});

describe("isNonStaffRole: who is not tenant staff", () => {
  it("excludes the org's external_auditor role", () => {
    expect(isNonStaffRole({ key: "external_auditor", organizationId: "org-1" })).toBe(true);
  });

  it("excludes any platform-owned reserved role (an operator bound into a tenant for alerts)", () => {
    expect(isNonStaffRole({ key: "platform_alert_audience", organizationId: null })).toBe(true);
    expect(isNonStaffRole({ key: "platform_ops", organizationId: null })).toBe(true);
    expect(isNonStaffRole({ key: "ai_safety_owner", organizationId: null })).toBe(true);
  });

  it("does not exclude ordinary clinical and administrative roles", () => {
    for (const key of ["org_admin", "registered_nurse", "medical_director", "billing_specialist"]) {
      expect(isNonStaffRole({ key, organizationId: "org-1" })).toBe(false);
      expect(isNonStaffRole({ key, organizationId: null })).toBe(false);
    }
  });

  it("a tenant-owned role that merely LOOKS like platform authority confers nothing and does not exclude (reserved keys are platform-owned only)", () => {
    expect(isNonStaffRole({ key: "platform_admin", organizationId: "org-1" })).toBe(false);
  });
});

describe("normalizeReason / normalizeOptionalRef", () => {
  it("trims, collapses whitespace and bounds the length", () => {
    expect(normalizeReason("  signed   order   form  ")).toBe("signed order form");
    expect(() => normalizeReason("too short")).not.toThrow(); // 9 characters
    expect(() => normalizeReason("short")).toThrow(ChartWardenError);
    expect(() => normalizeReason("x".repeat(501))).toThrow(ChartWardenError);
    expect(() => normalizeReason(undefined)).toThrow(ChartWardenError);
  });

  it("strips control characters and refuses NUL", () => {
    expect(normalizeReason("signed\u0007 order form")).toBe("signed order form");
    expect(() => normalizeReason("signed\u0000 order form")).toThrow(/NUL/);
  });

  it("refuses text that looks like a patient identifier, without echoing it", () => {
    let message = "";
    try {
      normalizeReason("customer read out 900-12-3456 on the call");
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/patient identifier/);
    expect(message).not.toContain("900-12-3456");
  });

  it("an optional reference is null when blank, bounded otherwise", () => {
    expect(normalizeOptionalRef("orderFormRef", undefined, 10)).toBeNull();
    expect(normalizeOptionalRef("orderFormRef", "   ", 10)).toBeNull();
    expect(normalizeOptionalRef("orderFormRef", " OF-2026-17 ", 20)).toBe("OF-2026-17");
    expect(() => normalizeOptionalRef("orderFormRef", "x".repeat(11), 10)).toThrow(
      ChartWardenError,
    );
  });
});

describe("parseStrict: no coercion on money", () => {
  const body = {
    planId: "11111111-1111-4111-8111-111111111111",
    staffCount: 3,
    averageDailyCensus: 9.5,
    expectedNetCollectionsCents: 1000,
    billingServiceMode: "none",
  };

  it("accepts exactly what the schema says", () => {
    expect(parseStrict(PricePreviewBody, body)).toEqual(body);
  });

  it("does NOT truncate 1.5 cents to 1 or read the string '1' as a number", () => {
    expect(() =>
      parseStrict(PricePreviewBody, { ...body, expectedNetCollectionsCents: 1.5 }),
    ).toThrow();
    expect(() => parseStrict(PricePreviewBody, { ...body, staffCount: "3" })).toThrow();
  });
});

describe("buildPricePreview", () => {
  const plan = (over: Partial<PricingPlanView> = {}): PricingPlanView => ({
    id: "11111111-1111-4111-8111-111111111111",
    familySlug: "demo",
    version: 1,
    slug: "demo-v1",
    name: "Demo",
    description: null,
    status: "draft",
    offered: false,
    currencyCode: "USD",
    perUserPriceCents: 1_000,
    bands: [
      { minAdc: 0, maxAdc: 9, monthlyFeeCents: 5_000 },
      { minAdc: 10, maxAdc: null, monthlyFeeCents: 9_000 },
    ],
    billingSoftwareBps: 100,
    managedBillingBps: 300,
    contractTermMonths: 12,
    implementationFeeCents: 2_000,
    minimumMonthlyCents: null,
    supersedesPlanId: null,
    publishedAt: null,
    archivedAt: null,
    createdAt: "2026-11-05T00:00:00.000Z",
    updatedAt: "2026-11-05T00:00:00.000Z",
    ...over,
  });
  const input = {
    staffCount: 4,
    averageDailyCensus: 9.99,
    expectedNetCollectionsCents: 100_000,
    billingServiceMode: "billing_software" as const,
  };

  it("can price a DRAFT plan, so an operator sees a price before it is published", () => {
    const p = buildPricePreview(plan(), input);
    expect(p.plan.status).toBe("draft");
    expect(p.platformFee).toMatchObject({
      bandMinAdc: 0,
      bandFeeCents: 5_000,
      feeCents: 5_000,
      basis: "census_band",
    });
    expect(p.billing.feeCents).toBe(1_000);
    expect(p.monthlyCents).toBe(6_000);
    expect(p.firstMonthCents).toBe(8_000);
  });

  it("an ADC of 10 moves to the next band", () => {
    expect(
      buildPricePreview(plan(), { ...input, averageDailyCensus: 10 }).platformFee.bandFeeCents,
    ).toBe(9_000);
  });

  it("refuses a plan with no prices", () => {
    expect(() => buildPricePreview(plan({ perUserPriceCents: null }), input)).toThrow(
      ChartWardenError,
    );
  });
});
