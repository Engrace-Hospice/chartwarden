import { describe, expect, it } from "vitest";
import { stagedPaymentDate } from "../claimmd-era-payment-date";

describe("staged Claim.MD payment date", () => {
  it("uses BPR16 when the sealed transaction set carries it", () => {
    expect(stagedPaymentDate({ paymentEffectiveDate: "2026-06-15", productionDate: null })).toEqual(
      {
        day: "2026-06-15",
        source: "payment_effective_date",
      },
    );
  });

  it("keeps the strict rule for a stage that has the field: a null or invalid BPR16 is refused even with a production day", () => {
    const productionDate = "2026-06-20T00:00:00Z";
    expect(stagedPaymentDate({ paymentEffectiveDate: null, productionDate })).toBeNull();
    expect(stagedPaymentDate({ paymentEffectiveDate: "", productionDate })).toBeNull();
    expect(stagedPaymentDate({ paymentEffectiveDate: "not-a-date", productionDate })).toBeNull();
  });

  it("treats a sealed JSON null as having the field (a stage sealed after migration 1508 with no BPR16)", () => {
    const sealed: unknown = JSON.parse(
      JSON.stringify({ paymentEffectiveDate: null, productionDate: "2026-06-20T00:00:00Z" }),
    );
    expect(stagedPaymentDate(sealed as Parameters<typeof stagedPaymentDate>[0])).toBeNull();
  });

  it("falls back to the legacy production day only for a stage that predates the field", () => {
    const sealed: unknown = JSON.parse(JSON.stringify({ productionDate: "2026-06-20T00:00:00Z" }));
    expect(stagedPaymentDate(sealed as Parameters<typeof stagedPaymentDate>[0])).toEqual({
      day: "2026-06-20",
      source: "legacy_production_date",
    });
    expect(stagedPaymentDate({ productionDate: "2026-06-20" })).toEqual({
      day: "2026-06-20",
      source: "legacy_production_date",
    });
  });

  it("reads the legacy production day in UTC, not the host zone", () => {
    expect(stagedPaymentDate({ productionDate: "2026-06-30T23:30:00-05:00" })).toEqual({
      day: "2026-07-01",
      source: "legacy_production_date",
    });
  });

  it("is null when a pre-field stage has no usable production day either", () => {
    expect(stagedPaymentDate({ productionDate: null })).toBeNull();
    expect(stagedPaymentDate({ productionDate: "garbage" })).toBeNull();
  });
});
