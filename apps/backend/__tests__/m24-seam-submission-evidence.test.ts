// M24 → M25 submission-evidence seam: a result that is not proven hides every identity that would let a caller
// follow the claim, its lineage or its submission (claim, replaces/replaced-by, submission, assignment ids).
// Runs the real projection over a scripted database handle; the live f172 suite covers the SQL itself.
import { describe, expect, it } from "vitest";
import type { M24ReadService } from "../src/modules/24-billing-medicaid/routes/read-service";
import { buildM24SeamImpls } from "../src/modules/24-billing-medicaid/seam-impls";
import { createFakeDb } from "./_fake-drizzle-db";

const ORG = "e1000000-0000-4000-8000-000000000001";
const PE = "e2000000-0000-4000-8000-000000000001";
const CLAIM = "e3000000-0000-4000-8000-000000000001";
const SUCCESSOR = "e3000000-0000-4000-8000-000000000002";
const PREDECESSOR = "e3000000-0000-4000-8000-000000000003";
const SUBMISSION = "e4000000-0000-4000-8000-000000000001";
const ASSIGNMENT = "e5000000-0000-4000-8000-000000000001";
const PAYER = "e6000000-0000-4000-8000-000000000001";
const CLASSIFICATION = "e7000000-0000-4000-8000-000000000001";
const CCN = "AB1234OR260201ABC00";

/** One joined row: a claim with a fully provenanced production submission and a verified assignment. */
const provenRow = (extra: Record<string, unknown> = {}) => ({
  claimId: CLAIM,
  organizationId: ORG,
  providerEntityId: PE,
  claimControlNumber: CCN,
  canonicalPayerId: PAYER,
  programAssignmentId: ASSIGNMENT,
  programKind: "ffs_open_card",
  serviceState: "OR",
  serviceFrom: new Date("2026-02-01T00:00:00.000Z"),
  serviceTo: new Date("2026-02-28T00:00:00.000Z"),
  claimState: "ACK_ACCEPTED",
  claimVersion: 4,
  replacesClaimId: null,
  replacedByClaimId: null,
  submissionId: SUBMISSION,
  attemptIndex: 0,
  submittedClaimVersion: 4,
  sourceAccountRef: "account:synthetic-1",
  environment: "production",
  vendor: "synthetic-vendor",
  vendorTransactionId: "synthetic-tx-1",
  payerId: PAYER,
  payerClassificationId: CLASSIFICATION,
  programKindSnapshot: "ffs_open_card",
  assignmentId: ASSIGNMENT,
  assignmentVersionSnapshot: 2,
  provenanceStatus: "verified",
  result: "accepted_sync",
  submittedAt: new Date("2026-03-01T00:00:00.000Z"),
  ackKind: null,
  ackOutcome: null,
  payerClaimControlNumber: null,
  ackReceivedAt: null,
  assignmentStatus: "verified",
  assignmentVersion: 2,
  assignmentPayerId: PAYER,
  assignmentClassificationId: CLASSIFICATION,
  assignmentState: "OR",
  ...extra,
});

async function evidenceFor(rows: readonly unknown[]) {
  const fake = createFakeDb({ select: [rows] });
  const seams = buildM24SeamImpls(fake.db, {} as unknown as M24ReadService);
  return seams.claimMatch.submissionEvidenceForLine(ORG, PE, { claimControlNumber: CCN });
}

describe("submissionEvidenceForLine", () => {
  it("returns the identities of a proven, active claim", async () => {
    const [result] = await evidenceFor([provenRow({ replacesClaimId: PREDECESSOR })]);
    expect(result).toMatchObject({
      disposition: "SUBMISSION_EVIDENCE",
      claimId: CLAIM,
      replacesClaimId: PREDECESSOR,
      replacedByClaimId: null,
      attempts: [{ submissionId: SUBMISSION, assignmentId: ASSIGNMENT }],
    });
  });

  it("hides every identity of a REPLACED claim, including its successor", async () => {
    const [result] = await evidenceFor([
      provenRow({
        claimState: "REPLACED",
        replacedByClaimId: SUCCESSOR,
        replacesClaimId: PREDECESSOR,
      }),
    ]);
    expect(result).toMatchObject({
      disposition: "SUBMISSION_UNVERIFIED",
      claimId: null,
      replacesClaimId: null,
      replacedByClaimId: null,
      attempts: [{ submissionId: null, assignmentId: null }],
    });
  });

  it.each([
    ["a non-production environment", { environment: "test" }],
    ["unverified provenance", { provenanceStatus: "unverified" }],
    ["a claim version mismatch", { submittedClaimVersion: 3 }],
    ["an assignment that is no longer verified", { assignmentStatus: "revoked" }],
  ])("hides every identity when the submission is unqualified by %s", async (_label, extra) => {
    const [result] = await evidenceFor([provenRow({ replacesClaimId: PREDECESSOR, ...extra })]);
    expect(result).toMatchObject({
      disposition: "SUBMISSION_UNVERIFIED",
      claimId: null,
      replacesClaimId: null,
      replacedByClaimId: null,
      attempts: [{ submissionId: null, assignmentId: null }],
    });
    // what stays visible is the non-identifying evidence the reviewer needs to see why it is unproven
    expect(result).toMatchObject({ claimState: expect.any(String), claimVersion: 4 });
  });

  it("hides identities when two attempts both qualify", async () => {
    const second = provenRow({
      submissionId: "e4000000-0000-4000-8000-000000000002",
      attemptIndex: 1,
    });
    const [result] = await evidenceFor([provenRow(), second]);
    expect(result).toMatchObject({ disposition: "SUBMISSION_UNVERIFIED", claimId: null });
    expect(result?.attempts.map((a) => a.submissionId)).toEqual([null, null]);
  });
});
