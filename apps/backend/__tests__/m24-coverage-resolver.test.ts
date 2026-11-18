import type { PatientCoverage, PatientCoverageReader } from "@chartwarden/types";
import { describe, expect, it, vi } from "vitest";
import { coverageForRange as resolveCoverageForRange } from "../src/modules/05-patient/coverage-intervals";
import { buildM24MedicaidCoverageResolver } from "../src/modules/24-billing-medicaid/routes/write-service-drizzle";

const medicaid: PatientCoverage = {
  id: "medicaid-secondary",
  patientId: "synthetic-patient-1",
  payerId: "synthetic-payer-medicaid",
  rank: 2,
  coverageKind: "medicaid",
  subscriberId: "synthetic-member-0001",
  groupNumber: null,
  current: true,
  effectiveFrom: "2026-01-01",
  effectiveTo: null,
};
const medicare: PatientCoverage = {
  ...medicaid,
  id: "medicare-primary",
  payerId: "synthetic-payer-medicare",
  rank: 1,
  coverageKind: "medicare_ffs",
  subscriberId: "synthetic-member-0002",
};

function readerFor(coverages: readonly PatientCoverage[]) {
  const coverageForRange = vi.fn(
    async (q: Parameters<PatientCoverageReader["coverageForRange"]>[0]) =>
      resolveCoverageForRange(coverages, { from: q.from, to: q.to }, q.coverageKind),
  );
  const coverageSnapshotForRangeInTransaction = vi.fn(
    async (
      _transaction: unknown,
      q: Parameters<PatientCoverageReader["coverageSnapshotForRangeInTransaction"]>[1],
    ) => ({
      coverages,
      resolution: resolveCoverageForRange(coverages, { from: q.from, to: q.to }, q.coverageKind),
      primaryResolution: resolveCoverageForRange(coverages, { from: q.from, to: q.to }),
    }),
  );
  const reader = {
    activeCoverageOfKind: vi.fn(),
    coverageForRange,
    coverageSnapshotForRangeInTransaction,
  } satisfies Pick<
    PatientCoverageReader,
    "activeCoverageOfKind" | "coverageForRange" | "coverageSnapshotForRangeInTransaction"
  >;
  return { reader, coverageForRange, coverageSnapshotForRangeInTransaction };
}

describe("M24 cross-kind, range-wide coverage resolution (#876/#877)", () => {
  it("keeps the eligibility refresh lookup as a single-date Medicaid read", async () => {
    const { reader } = readerFor([medicaid]);
    reader.activeCoverageOfKind = vi.fn(async () => medicaid);
    const resolver = buildM24MedicaidCoverageResolver(() => reader);

    await expect(
      resolver.activeMedicaidCoverage({
        organizationId: "synthetic-org-1",
        patientId: "synthetic-patient-1",
        onDate: "2026-01-15",
      }),
    ).resolves.toMatchObject({ id: "medicaid-secondary", rank: 2 });
    expect(reader.activeCoverageOfKind).toHaveBeenCalledWith({
      organizationId: "synthetic-org-1",
      patientId: "synthetic-patient-1",
      coverageKind: "medicaid",
      onDate: "2026-01-15",
    });
  });

  it("resolves Medicaid and Medicare-primary coverage from M5's interval semantics", async () => {
    const { reader, coverageForRange } = readerFor([medicaid, medicare]);
    const resolver = buildM24MedicaidCoverageResolver(() => reader);

    const result = await resolver.claimCoverageForRange({
      organizationId: "synthetic-org-1",
      patientId: "synthetic-patient-1",
      from: "2026-01-01",
      to: "2026-01-31",
    });

    expect(result.medicaid).toMatchObject({
      status: "uniform",
      coverage: { id: "medicaid-secondary", rank: 2, coverageKind: "medicaid" },
    });
    expect(result.primary).toMatchObject({
      status: "uniform",
      coverage: { id: "medicare-primary", rank: 1, coverageKind: "medicare_ffs" },
    });
    expect(coverageForRange).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ coverageKind: "medicaid" }),
    );
    expect(coverageForRange).toHaveBeenNthCalledWith(2, {
      organizationId: "synthetic-org-1",
      patientId: "synthetic-patient-1",
      from: "2026-01-01",
      to: "2026-01-31",
    });
  });

  it("detects a primary-payer change wholly inside the service window", async () => {
    const commercial: PatientCoverage = {
      ...medicare,
      id: "commercial-primary",
      payerId: "synthetic-payer-commercial",
      coverageKind: "commercial",
      effectiveFrom: "2026-01-16",
    };
    const expiringMedicare: PatientCoverage = {
      ...medicare,
      effectiveTo: "2026-01-15",
      current: false,
    };
    const { reader } = readerFor([medicaid, expiringMedicare, commercial]);
    const resolver = buildM24MedicaidCoverageResolver(() => reader);

    const result = await resolver.claimCoverageForRange({
      organizationId: "synthetic-org-1",
      patientId: "synthetic-patient-1",
      from: "2026-01-01",
      to: "2026-01-31",
    });

    expect(result.medicaid.status).toBe("uniform");
    expect(result.primary).toEqual({ status: "changes", onDate: "2026-01-16" });
  });

  it("derives both transaction resolutions from one M5 locked snapshot call", async () => {
    const transaction = { marker: "claim-write" };
    const { reader, coverageSnapshotForRangeInTransaction } = readerFor([medicaid, medicare]);
    const resolver = buildM24MedicaidCoverageResolver(() => reader);

    const result = await resolver.claimCoverageSnapshotInTransaction(transaction, {
      organizationId: "synthetic-org-1",
      patientId: "synthetic-patient-1",
      from: "2026-01-01",
      to: "2026-01-31",
    });

    expect(result.medicaid).toMatchObject({
      status: "uniform",
      coverage: { id: "medicaid-secondary" },
    });
    expect(result.primary).toMatchObject({
      status: "uniform",
      coverage: { id: "medicare-primary" },
    });
    expect(coverageSnapshotForRangeInTransaction).toHaveBeenCalledTimes(1);
    expect(coverageSnapshotForRangeInTransaction).toHaveBeenCalledWith(transaction, {
      organizationId: "synthetic-org-1",
      patientId: "synthetic-patient-1",
      from: "2026-01-01",
      to: "2026-01-31",
      coverageKind: "medicaid",
    });
  });
});
