import { describe, expect, it } from "vitest";
import { assessHistoricalMatchCandidate } from "../claimmd-era-review";

const candidate = {
  module: "M23" as const,
  evidenceId: "30000000-0000-4000-8000-000000000001",
  claimId: "40000000-0000-4000-8000-000000000001",
  submissionId: "50000000-0000-4000-8000-000000000001",
  attemptKey: "50000000-0000-4000-8000-000000000001:1",
  organizationId: "10000000-0000-4000-8000-000000000001",
  providerEntityId: "20000000-0000-4000-8000-000000000001",
  accountReference: "synthetic-account",
  usage: "test" as const,
  payerId: "payer-test",
  pcn: "synthetic-pcn",
  claimType: "0811",
  serviceFrom: "2026-01-01",
  serviceTo: "2026-01-31",
  chargeCents: 12500,
  lineage: "original" as const,
  attemptState: "sent",
  submittedAt: "2026-02-01T00:00:00.000Z",
  submittedLines: "unavailable" as const,
};

const context = {
  organizationId: candidate.organizationId,
  providerEntityId: candidate.providerEntityId,
  accountReference: candidate.accountReference,
  usage: "test" as const,
  pcn: candidate.pcn,
  payerId: candidate.payerId,
  serviceFrom: candidate.serviceFrom,
  serviceTo: candidate.serviceTo,
  chargeCents: candidate.chargeCents,
};

describe("historical ERA claim candidates", () => {
  it("permits an audited human choice only with scoped payer, period and charge evidence", () => {
    const result = assessHistoricalMatchCandidate({ candidate, ...context });
    expect(result.selectable).toBe(true);
    expect(result.supportingEvidence).toHaveLength(5);
    expect(result.submittedLines).toBe("unavailable");
  });

  it("does not turn a reused PCN or weak amount/date similarity into an eligible candidate", () => {
    expect(
      assessHistoricalMatchCandidate({ candidate, ...context, payerId: "other-payer" }).selectable,
    ).toBe(false);
    expect(
      assessHistoricalMatchCandidate({
        candidate,
        ...context,
        organizationId: "10000000-0000-4000-8000-000000000002",
      }).selectable,
    ).toBe(false);
    expect(
      assessHistoricalMatchCandidate({ candidate, ...context, serviceFrom: null }).selectable,
    ).toBe(false);
  });

  it("compares immutable X12 compact dates with normalized ERA service dates", () => {
    const result = assessHistoricalMatchCandidate({
      candidate: { ...candidate, serviceFrom: "20260101", serviceTo: "20260131" },
      ...context,
    });
    expect(result.selectable).toBe(true);
    expect(result.supportingEvidence).toContain("service period matches");
  });
});
