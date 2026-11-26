// M24 → M25 ERA enrollment-evidence seam: a verified 835 enrollment row is offered only when the same M40
// classification qualifier the verify route uses still qualifies it. M40 returns every classification row and the
// table is append-only, so a superseded row stays "verified" forever; a local filter that only looked at
// verificationStatus would keep offering evidence that verification itself now refuses.
// Runs the real seam over a scripted database handle and a scripted M40 provider; the live suites cover the SQL.
import type { MedicaidPayerProgramClassification } from "@chartwarden/mdm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { M24ReadService } from "../src/modules/24-billing-medicaid/routes/read-service";
import { buildM24SeamImpls } from "../src/modules/24-billing-medicaid/seam-impls";
import { createFakeDb } from "./_fake-drizzle-db";

const classifications = vi.hoisted(() => ({ rows: [] as unknown[] }));
vi.mock("../src/modules/40-mdm/seams", () => ({
  getMdmEntityProvider: () => ({
    medicaidPayerProgramClassifications: async () => classifications.rows,
  }),
}));

const ORG = "e1000000-0000-4000-8000-000000000001";
const PE = "e2000000-0000-4000-8000-000000000001";
const PAYER = "e6000000-0000-4000-8000-000000000001";

const classification = (
  overrides: Partial<MedicaidPayerProgramClassification> = {},
): MedicaidPayerProgramClassification => ({
  id: "class-a",
  canonicalPayerId: PAYER,
  stateCode: "OR",
  classification: "oregon_ffs",
  effectiveFrom: "2026-01-01",
  effectiveTo: null,
  verificationStatus: "verified",
  sourceKind: "state_registry",
  sourceReference: "registry:synthetic-source",
  verifiedAt: null,
  verifiedBy: null,
  supersedesId: null,
  recordedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

const enrollment = {
  clearinghouse: "claimmd",
  accountReference: "account:synthetic-1",
  environment: "production",
  serviceState: "OR",
  canonicalPayerId: PAYER,
  programKind: "ffs_open_card",
  vendorPayerId: "SYNTH01",
  effectiveFrom: "2026-01-01",
  effectiveTo: "2026-12-31",
  evidenceFreshUntil: "2026-12-31",
  evidenceReference: "doc:synthetic-835-enrollment",
  verifiedAt: new Date("2026-02-01T00:00:00.000Z"),
  updatedAt: new Date("2026-02-01T00:00:00.000Z"),
  evidenceId: "e8000000-0000-4000-8000-000000000001",
  evidenceVersion: 2,
  verificationSource: "payer_written_confirmation",
  status: "verified",
  transactionType: "835",
  evidenceKind: "835_era_enrollment",
};

async function offered(rows: readonly MedicaidPayerProgramClassification[]) {
  classifications.rows = [...rows];
  // First select: the provider entity's identifiers; second: the verified 835 enrollment rows.
  const fake = createFakeDb({ select: [[{ npi: "1234567893", ccn: "380001" }], [enrollment]] });
  const seams = buildM24SeamImpls(fake.db, {} as unknown as M24ReadService);
  return seams.claimMatch.eraEnrollmentEvidence(ORG, PE);
}

describe("claimMatch.eraEnrollmentEvidence", () => {
  beforeEach(() => {
    classifications.rows = [];
  });

  it("offers the row with the id of the one qualifying classification", async () => {
    const [evidence] = await offered([classification()]);
    expect(evidence).toMatchObject({ canonicalPayerId: PAYER, programId: "class-a" });
  });

  it("offers nothing when a later row superseded the covering classification", async () => {
    const result = await offered([
      classification(),
      classification({ id: "class-b", effectiveTo: "2026-03-31", supersedesId: "class-a" }),
    ]);
    expect(result).toEqual([]);
  });

  it("offers nothing when a second verified classification contradicts the window", async () => {
    const result = await offered([
      classification(),
      classification({
        id: "class-c",
        classification: "medicaid_cco",
        effectiveFrom: "2026-06-01",
      }),
    ]);
    expect(result).toEqual([]);
  });

  it("offers nothing when the only covering classification is not verified", async () => {
    const result = await offered([classification({ verificationStatus: "unverified" })]);
    expect(result).toEqual([]);
  });
});
