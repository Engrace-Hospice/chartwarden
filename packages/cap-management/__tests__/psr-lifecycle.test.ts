import { describe, expect, it } from "vitest";
import {
  CapTransitionError,
  ERASED_MBI_SENTINEL,
  assertTransition,
  canTransition,
  dollarsToCents,
  eraseCapTenant,
  isAccrualEligible,
  parsePsrCsv,
  reconcilePsr,
  redactCapPatient,
  statusOnFirstAccrual,
} from "../src/index";

describe("cap_period lifecycle (§2.2)", () => {
  it("only allows the canonical transitions", () => {
    expect(canTransition("open", "active")).toBe(true);
    expect(canTransition("active", "in_settlement")).toBe(true);
    expect(canTransition("in_settlement", "settled")).toBe(true);
    expect(canTransition("settled", "reopened")).toBe(true);
    expect(canTransition("reopened", "settled")).toBe(true);
    expect(canTransition("active", "settled")).toBe(false);
    expect(canTransition("open", "in_settlement")).toBe(false);
  });
  it("assertTransition throws CapTransitionError on an illegal hop", () => {
    expect(() => assertTransition("active", "settled")).toThrow(CapTransitionError);
  });
  it("accrual-eligibility and first-accrual promotion", () => {
    expect(isAccrualEligible("active")).toBe(true);
    expect(isAccrualEligible("reopened")).toBe(true);
    expect(isAccrualEligible("settled")).toBe(false);
    expect(statusOnFirstAccrual("open")).toBe("active");
    expect(statusOnFirstAccrual("active")).toBe("active");
  });
});

describe("PS&R CSV parse + reconcile (D9)", () => {
  it("parses dollars (incl. parens-negatives and thousands separators) to cents", () => {
    expect(dollarsToCents("$33,494.01")).toBe(3_349_401);
    expect(dollarsToCents("34465.34")).toBe(3_446_534);
    expect(dollarsToCents("(50.00)")).toBe(-5_000);
    expect(dollarsToCents("")).toBe(0);
  });
  it("parses a permissive CSV (BOM, header aliases, hyphen-stripped MBI)", () => {
    const csv =
      "﻿MBI,Paid Amount,Inpatient Days\r\n1EG4-TE5-MK73,1000.00,5\r\n2AB1-CD2-EF34,2000.00,3\r\n";
    const rows = parsePsrCsv(csv, "ngs");
    expect(rows).toEqual([
      { mbi: "1EG4TE5MK73", paidCents: 100_000, inpatientDays: 5 },
      { mbi: "2AB1CD2EF34", paidCents: 200_000, inpatientDays: 3 },
    ]);
  });
  it("diffs the ledger vs PS&R, marking lines above the $50 threshold", () => {
    const ledger = [
      { mbiNormalized: "1EG4TE5MK73", patientId: "p1", paidCents: 100_000 },
      { mbiNormalized: "2AB1CD2EF34", patientId: "p2", paidCents: 200_000 },
    ];
    const psr = [
      { mbi: "1EG4TE5MK73", paidCents: 100_000, inpatientDays: 5 }, // exact → no line
      { mbi: "2AB1CD2EF34", paidCents: 210_000, inpatientDays: 3 }, // +$100 variance
    ];
    const lines = reconcilePsr(ledger, psr);
    const benLines = lines.filter((l) => l.scope === "beneficiary");
    expect(benLines).toHaveLength(1);
    expect(benLines[0]).toMatchObject({
      patientId: "p2",
      varianceCents: 10_000,
      aboveThreshold: true,
    });
    const agg = lines.find((l) => l.scope === "agency_aggregate")!;
    expect(agg.varianceCents).toBe(10_000);
  });
  it("flags an MBI present only on the PS&R side as mbi_mismatch", () => {
    const lines = reconcilePsr([], [{ mbi: "9ZZ9ZZ9ZZ99", paidCents: 5_000, inpatientDays: 0 }]);
    const ben = lines.find((l) => l.scope === "beneficiary")!;
    expect(ben.varianceReason).toBe("mbi_mismatch");
    expect(ben.patientId).toBeNull();
  });
});

describe("eraser (§3.7 / D14)", () => {
  it("tenant destruction deletes every cap_* table FK-ordered", async () => {
    const calls: string[] = [];
    const counts = await eraseCapTenant(
      new Proxy(
        {},
        {
          get: (_t, prop: string) => async () => {
            calls.push(prop);
            return 1;
          },
        },
      ) as never,
      "org-1",
    );
    expect(calls[0]).toBe("deletePsrReconciliation"); // children before parents
    expect(calls[calls.length - 1]).toBe("deletePeriods");
    expect(counts.cap_period).toBe(1);
  });
  it("patient redaction retains aggregates (D14), redacting only the PHI link", async () => {
    const store = {
      redactBeneficiaryAccrual: async () => 1,
      redactAccrualLines: async () => 3,
      redactInpatientDayLines: async () => 0,
      redactProjectionSnapshots: async () => 2,
      redactThresholdEvents: async () => 0,
      redactPsrReconciliation: async () => 0,
    };
    const counts = await redactCapPatient(store, "org-1", "p1");
    expect(counts.cap_beneficiary_accrual_line).toBe(3);
    expect(ERASED_MBI_SENTINEL).toBe("[ERASED]");
  });
});
