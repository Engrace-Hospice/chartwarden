import type { PatientCoverageReader } from "@chartwarden/types";
import { describe, expect, it, vi } from "vitest";
import { buildM24MedicaidCoverageResolver } from "../src/modules/24-billing-medicaid/routes/write-service-drizzle";

describe("M24 transaction-bound coverage resolver (#877)", () => {
  it("uses the caller transaction and returns only a uniform Medicaid snapshot", async () => {
    const transaction = { marker: "claim-write" };
    const coverageSnapshotForRangeInTransaction = vi.fn(async () => ({
      coverages: [],
      resolution: {
        status: "uniform" as const,
        coverage: {
          id: "patient-payer-1",
          patientId: "patient-1",
          payerId: "payer-1",
          rank: 1,
          coverageKind: "medicaid",
          subscriberId: "synthetic-member-0001",
          groupNumber: null,
          current: true,
          effectiveFrom: "2026-01-01",
          effectiveTo: null,
        },
      },
    }));
    const reader = {
      activeCoverageOfKind: vi.fn(),
      coverageForRange: vi.fn(),
      coverageSnapshotForRangeInTransaction,
    } satisfies Pick<
      PatientCoverageReader,
      "activeCoverageOfKind" | "coverageForRange" | "coverageSnapshotForRangeInTransaction"
    >;
    const resolver = buildM24MedicaidCoverageResolver(() => reader);

    await expect(
      resolver.activeMedicaidCoverageInTransaction(transaction, {
        organizationId: "org-1",
        patientId: "patient-1",
        onDate: "2026-01-01",
        throughDate: "2026-01-31",
      }),
    ).resolves.toEqual({
      id: "patient-payer-1",
      payerId: "payer-1",
      subscriberId: "synthetic-member-0001",
      rank: 1,
    });
    expect(coverageSnapshotForRangeInTransaction).toHaveBeenCalledWith(transaction, {
      organizationId: "org-1",
      patientId: "patient-1",
      from: "2026-01-01",
      to: "2026-01-31",
      coverageKind: "medicaid",
    });
  });
});
