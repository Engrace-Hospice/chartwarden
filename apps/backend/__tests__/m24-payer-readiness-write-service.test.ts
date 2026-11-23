import { schema } from "@chartwarden/db";
// M24 payer-readiness write paths (program assignments, enrollment evidence, successor claims) against a
// scripted database handle. These prove the service's own decisions (status guards, payer requirements,
// what it writes); RLS and the table CHECKs are the live suites' job.
import { deriveMedicaidControlNumber } from "@chartwarden/medicaid-adapters";
import { describe, expect, it, vi } from "vitest";
import {
  type CanonicalPayerIdentityReader,
  buildDrizzleM24WriteService,
} from "../src/modules/24-billing-medicaid/routes/write-service-drizzle";
import { type RecordedStatement, createFakeDb } from "./_fake-drizzle-db";

const ORG = "a1000000-0000-4000-8000-000000000001";
const RECORDER = "a2000000-0000-4000-8000-000000000001";
const VERIFIER = "a2000000-0000-4000-8000-000000000002";
const PE = "a3000000-0000-4000-8000-000000000001";
const PATIENT = "a4000000-0000-4000-8000-000000000001";
const PAYER = "a5000000-0000-4000-8000-000000000001";
const ROW_ID = "a6000000-0000-4000-8000-000000000001";
const CLASSIFICATION_ID = "a7000000-0000-4000-8000-000000000001";
const EVIDENCE_REF = "doc:synthetic-evidence-1";

const actor = { organizationId: ORG, userId: VERIFIER, roles: [], membershipId: VERIFIER };

const PA = schema.medicaidProgramAssignment;
const EE = schema.medicaidEnrollmentEvidence;
const C = schema.medicaidClaim;

const assignmentRow = (extra: Record<string, unknown> = {}) => ({
  id: ROW_ID,
  organizationId: ORG,
  patientId: PATIENT,
  patientPayerId: "a8000000-0000-4000-8000-000000000001",
  admissionId: "a9000000-0000-4000-8000-000000000001",
  providerEntityId: PE,
  serviceState: "OR",
  programKind: "ffs_open_card",
  canonicalPayerId: PAYER,
  status: "pending",
  effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
  effectiveTo: null,
  recordedByMembershipId: RECORDER,
  version: 1,
  ...extra,
});

const evidenceRow = (extra: Record<string, unknown> = {}) => ({
  id: ROW_ID,
  organizationId: ORG,
  providerEntityId: PE,
  serviceState: "OR",
  programKind: null,
  canonicalPayerId: PAYER,
  clearinghouse: null,
  vendorPayerId: null,
  transactionType: null,
  evidenceKind: "mco_participation",
  status: "pending",
  effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
  effectiveTo: null,
  recordedByMembershipId: RECORDER,
  version: 1,
  ...extra,
});

function payerReader(): CanonicalPayerIdentityReader & {
  resolvePayer: ReturnType<typeof vi.fn>;
} {
  return {
    resolvePayer: vi.fn(async (_org: string, id: string) => ({
      id,
      displayName: "Synthetic Medicaid Payer",
      kind: "medicaid",
      stateCode: "OR",
      status: "active" as const,
    })),
    medicaidProgramClassifications: vi.fn(async () => [
      {
        id: CLASSIFICATION_ID,
        canonicalPayerId: PAYER,
        stateCode: "OR",
        classification: "oregon_ffs" as const,
        effectiveFrom: "2025-01-01",
        effectiveTo: null,
        verificationStatus: "verified" as const,
        sourceKind: "state_registry",
        sourceReference: "registry:synthetic-source",
        supersedesId: null,
      },
    ]),
  };
}

function serviceOver(
  fake: ReturnType<typeof createFakeDb>,
  reader: CanonicalPayerIdentityReader | undefined = payerReader(),
  adapters?: Parameters<typeof buildDrizzleM24WriteService>[12],
) {
  return buildDrizzleM24WriteService(
    fake.db,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    adapters,
    undefined,
    reader,
  );
}

const verifyAssignmentInput = {
  expectedVersion: 1,
  verificationSource: "state_portal" as const,
  evidenceReference: EVIDENCE_REF,
  providerEntityId: PE,
  patientId: PATIENT,
};

describe("verifyProgramAssignment", () => {
  it.each(["revoked", "verified", "rejected", "superseded"])(
    "refuses to verify an assignment that is already %s",
    async (status) => {
      const fake = createFakeDb({ select: [[assignmentRow({ status })]] });
      const reader = payerReader();
      await expect(
        serviceOver(fake, reader).verifyProgramAssignment(actor, ROW_ID, verifyAssignmentInput),
      ).rejects.toMatchObject({ code: "MEDICAID_ASSIGNMENT_NOT_PENDING", statusCode: 409 });
      expect(fake.of("update", PA)).toEqual([]);
      expect(reader.resolvePayer).not.toHaveBeenCalled();
    },
  );

  it.each(["pending", "candidate"])("verifies a %s assignment", async (status) => {
    const fake = createFakeDb({
      select: [[assignmentRow({ status })]],
      update: [[{ version: 2 }]],
    });
    await expect(
      serviceOver(fake).verifyProgramAssignment(actor, ROW_ID, verifyAssignmentInput),
    ).resolves.toEqual({ status: "verified", version: 2 });
    expect(fake.of("update", PA)[0]?.set).toMatchObject({
      status: "verified",
      verifiedByMembershipId: VERIFIER,
      canonicalPayerClassificationId: CLASSIFICATION_ID,
    });
  });

  it("answers a typed conflict, not a database cast error, when the assignment names no payer", async () => {
    const fake = createFakeDb({
      select: [[assignmentRow({ programKind: "managed_care", canonicalPayerId: null })]],
    });
    const reader = payerReader();
    await expect(
      serviceOver(fake, reader).verifyProgramAssignment(actor, ROW_ID, verifyAssignmentInput),
    ).rejects.toMatchObject({ code: "MEDICAID_CANONICAL_PAYER_REQUIRED", statusCode: 409 });
    expect(reader.resolvePayer).not.toHaveBeenCalled();
    expect(fake.of("update", PA)).toEqual([]);
  });
});

const verifyEvidenceInput = (verificationSource: string) => ({
  expectedVersion: 1,
  verificationSource: verificationSource as "payer_written_confirmation",
  evidenceReference: EVIDENCE_REF,
  providerEntityId: PE,
});

describe("verifyEnrollmentEvidence", () => {
  it.each(["revoked", "verified", "rejected", "expired", "superseded"])(
    "refuses to verify evidence that is already %s",
    async (status) => {
      const fake = createFakeDb({ select: [[evidenceRow({ status })]] });
      await expect(
        serviceOver(fake).verifyEnrollmentEvidence(
          actor,
          ROW_ID,
          verifyEvidenceInput("payer_written_confirmation"),
        ),
      ).rejects.toMatchObject({ code: "MEDICAID_ENROLLMENT_NOT_PENDING", statusCode: 409 });
      expect(fake.of("update", EE)).toEqual([]);
    },
  );

  it.each([
    ["mco_participation", null, "payer_written_confirmation"],
    ["837i_enrollment", "837I", "clearinghouse_written_confirmation"],
    ["835_era_enrollment", "835", "payer_written_confirmation"],
  ] as const)("refuses to verify %s evidence that names no payer", async (kind, tx, source) => {
    const fake = createFakeDb({
      select: [[evidenceRow({ evidenceKind: kind, transactionType: tx, canonicalPayerId: null })]],
    });
    await expect(
      serviceOver(fake).verifyEnrollmentEvidence(actor, ROW_ID, verifyEvidenceInput(source)),
    ).rejects.toMatchObject({ code: "MEDICAID_EVIDENCE_PAYER_REQUIRED", statusCode: 409 });
    expect(fake.of("update", EE)).toEqual([]);
  });

  it("still verifies state provider enrollment without a payer", async () => {
    const fake = createFakeDb({
      select: [
        [
          evidenceRow({
            evidenceKind: "state_medicaid_provider_enrollment",
            canonicalPayerId: null,
          }),
        ],
      ],
      update: [[{ version: 2 }]],
    });
    await expect(
      serviceOver(fake).verifyEnrollmentEvidence(
        actor,
        ROW_ID,
        verifyEvidenceInput("state_portal"),
      ),
    ).resolves.toEqual({ status: "verified", version: 2 });
    expect(fake.of("update", EE)[0]?.set).toMatchObject({ status: "verified" });
  });

  it("verifies pending payer-bound evidence", async () => {
    const fake = createFakeDb({ select: [[evidenceRow()]], update: [[{ version: 2 }]] });
    await expect(
      serviceOver(fake).verifyEnrollmentEvidence(
        actor,
        ROW_ID,
        verifyEvidenceInput("payer_written_confirmation"),
      ),
    ).resolves.toEqual({ status: "verified", version: 2 });
  });
});

describe("revocation", () => {
  it("only revokes verified rows", async () => {
    const fake = createFakeDb({ select: [[assignmentRow({ status: "revoked" })]] });
    await expect(
      serviceOver(fake).revokeProgramAssignment(actor, ROW_ID, {
        expectedVersion: 1,
        reasonCode: "other",
        providerEntityId: PE,
        patientId: PATIENT,
      }),
    ).rejects.toMatchObject({ code: "MEDICAID_ASSIGNMENT_NOT_VERIFIED" });
  });
});

describe("successor claims (TOB 817 / 818)", () => {
  const ORIGINAL = "b1000000-0000-4000-8000-000000000001";
  const ASSIGNMENT = "b2000000-0000-4000-8000-000000000001";
  const snapshot = {
    status: "verified",
    reasonCode: "PROGRAM_RESPONSIBILITY_VERIFIED",
    assignmentIds: [ASSIGNMENT],
    serviceFrom: "2026-02-01",
    serviceTo: "2026-02-28",
    serviceState: "OR",
  };
  const originalClaim = () => ({
    id: ORIGINAL,
    organizationId: ORG,
    providerEntityId: PE,
    locationId: null,
    patientId: PATIENT,
    patientPayerId: "b3000000-0000-4000-8000-000000000001",
    admissionId: "b4000000-0000-4000-8000-000000000001",
    serviceState: "OR",
    kind: "hospice_only",
    tob: "811",
    serviceFrom: new Date("2026-02-01T00:00:00.000Z"),
    serviceTo: new Date("2026-02-28T00:00:00.000Z"),
    statePlanCodeId: "b5000000-0000-4000-8000-000000000001",
    statePlanCodeSnapshot: "OR-HOSPICE",
    mcoId: null,
    mcoSnapshot: null,
    medicaidProgramKind: "ffs_open_card",
    canonicalPayerId: PAYER,
    programAssignmentId: ASSIGNMENT,
    programResolutionSnapshot: snapshot,
    medicareClaimId: null,
    medicareSecondaryContextSnapshot: null,
    rbArrangementId: null,
    medicaidClaimControlNumber: deriveMedicaidControlNumber({
      ccn: "AB1234",
      serviceState: "OR",
      serviceFrom: "2026-02-01",
      claimId: ORIGINAL,
      attemptIndex: 0,
    }),
    state: "ACK_ACCEPTED",
    version: 3,
  });
  const adapters = {
    adapterForState: () => ({
      replacementTob: () => "817",
      voidTob: () => "818",
    }),
  };

  it.each(["replaceClaim", "voidClaim"] as const)(
    "%s carries the verified program identity onto the successor",
    async (method) => {
      const fake = createFakeDb({
        select: [[originalClaim()]],
        insert: [
          (s: RecordedStatement) => [
            { ...(s.values as object), version: 1, createdAt: new Date(), updatedAt: new Date() },
          ],
          [],
        ],
      });
      const service = serviceOver(fake, undefined, adapters);
      await service[method](actor, ORIGINAL, { expectedVersion: 3, reason: "x".repeat(40) });
      expect(fake.of("insert", C)[0]?.values).toMatchObject({
        replacesClaimId: ORIGINAL,
        medicaidProgramKind: "ffs_open_card",
        canonicalPayerId: PAYER,
        programAssignmentId: ASSIGNMENT,
        programResolutionSnapshot: snapshot,
      });
    },
  );
});
