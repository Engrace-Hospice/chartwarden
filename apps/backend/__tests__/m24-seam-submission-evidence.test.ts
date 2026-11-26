// M24 → M25 submission-evidence seam: a result that is not proven hides every identity that would let a caller
// follow the claim, its lineage or its submission (claim, replaces/replaced-by, submission, assignment ids) and every
// vendor- or payer-side reference of its attempts (vendor transaction id, payer classification id, source account,
// the payer claim control number on an acknowledgment). A proven result returns them unchanged.
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
const PAYER_CCN = "PCN-SYNTHETIC-0001";

/** The acknowledgment columns of a joined row, for a claim whose submission was acknowledged by the payer. */
const acknowledged = {
  ackId: "e9000000-0000-4000-8000-000000000001",
  ackKind: "277CA",
  ackOutcome: "accepted",
  payerClaimControlNumber: PAYER_CCN,
  ackReceivedAt: new Date("2026-03-02T00:00:00.000Z"),
};

/** Every attempt-level identifier or vendor-side reference an unproven result must not carry. */
const HIDDEN_REFERENCES = {
  submissionId: null,
  assignmentId: null,
  vendorTransactionId: null,
  payerClassificationId: null,
  sourceAccountRef: null,
};

/** One joined row: a claim with a fully provenanced production submission and a verified assignment. */
const provenRow = (extra: Record<string, unknown> = {}) => ({
  claimId: CLAIM,
  organizationId: ORG,
  providerEntityId: PE,
  claimControlNumber: CCN,
  canonicalPayerId: PAYER,
  claimMcoId: null,
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
  submittedServiceState: "OR",
  submittedChannel: "direct_mmis",
  submittedMcoIdSnapshot: null,
  submittedClaimControlNumber: CCN,
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
  ackAcceptedLineNumbers: null,
  ackRejectedLineNumbers: null,
  ackErrorCodes: null,
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
  it("returns the identities and references of a proven, active claim unchanged", async () => {
    const [result] = await evidenceFor([
      provenRow({ replacesClaimId: PREDECESSOR, ...acknowledged }),
    ]);
    expect(result).toMatchObject({
      disposition: "SUBMISSION_EVIDENCE",
      claimId: CLAIM,
      replacesClaimId: PREDECESSOR,
      replacedByClaimId: null,
      attempts: [
        {
          submissionId: SUBMISSION,
          assignmentId: ASSIGNMENT,
          vendorTransactionId: "synthetic-tx-1",
          payerClassificationId: CLASSIFICATION,
          sourceAccountRef: "account:synthetic-1",
          acknowledgments: [
            { kind: "277CA", outcome: "accepted", payerClaimControlNumber: PAYER_CCN },
          ],
        },
      ],
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
      claimControlNumber: null,
      canonicalPayerId: null,
      programKind: null,
      replacesClaimId: null,
      replacedByClaimId: null,
      attempts: [HIDDEN_REFERENCES],
    });
    expect(result?.attempts[0]).toMatchObject({ payerId: null, programKind: null });
  });

  it.each([
    ["a non-production environment", { environment: "test" }],
    ["unverified provenance", { provenanceStatus: "unverified" }],
    ["a claim version mismatch", { submittedClaimVersion: 3 }],
    ["a submitted service state mismatch", { submittedServiceState: "WA" }],
    ["a submitted claim control mismatch", { submittedClaimControlNumber: "OTHER-CONTROL" }],
    [
      "a submitted MCO identity mismatch",
      { submittedMcoIdSnapshot: "e8000000-0000-4000-8000-000000000001" },
    ],
    ["a submitted channel mismatch", { submittedChannel: "cco_clearinghouse" }],
    ["an assignment that is no longer verified", { assignmentStatus: "revoked" }],
    // the attempt's payer snapshot differs from the claim's payer
    ["an attempt sent to another payer", { payerId: "b0000000-0000-4000-8000-0000000000ff" }],
  ])("hides every identity when the submission is unqualified by %s", async (_label, extra) => {
    const [result] = await evidenceFor([
      provenRow({ replacesClaimId: PREDECESSOR, ...acknowledged, ...extra }),
    ]);
    expect(result).toMatchObject({
      disposition: "SUBMISSION_UNVERIFIED",
      claimId: null,
      replacesClaimId: null,
      replacedByClaimId: null,
      attempts: [HIDDEN_REFERENCES],
    });
    // the acknowledgment survives as status only: its payer claim control number is a payer-side reference
    expect(result?.attempts[0]?.acknowledgments).toEqual([
      {
        id: null,
        kind: "277CA",
        outcome: "accepted",
        payerClaimControlNumber: null,
        receivedAt: "2026-03-02T00:00:00.000Z",
      },
    ]);
    // what stays visible is the non-identifying evidence the reviewer needs to see why it is unproven
    expect(result).toMatchObject({ claimState: expect.any(String), claimVersion: 4 });
    expect(result?.attempts[0]).toMatchObject({
      attemptIndex: 0,
      claimVersion: expect.anything(),
      environment: expect.any(String),
      vendor: "synthetic-vendor",
      provenanceStatus: expect.any(String),
      result: "accepted_sync",
      submittedAt: "2026-03-01T00:00:00.000Z",
    });
  });

  it("hides identities when two attempts both qualify", async () => {
    const second = provenRow({
      submissionId: "e4000000-0000-4000-8000-000000000002",
      attemptIndex: 1,
    });
    const [result] = await evidenceFor([provenRow(), second]);
    expect(result).toMatchObject({ disposition: "SUBMISSION_UNVERIFIED", claimId: null });
    expect(result?.attempts.map((a) => a.submissionId)).toEqual([null, null]);
    expect(result?.attempts.map((a) => a.vendorTransactionId)).toEqual([null, null]);
    expect(result?.attempts.map((a) => a.payerClassificationId)).toEqual([null, null]);
    expect(result?.attempts.map((a) => a.sourceAccountRef)).toEqual([null, null]);
  });

  it("changes the source fingerprint when persisted acknowledgment line facts change", async () => {
    const [accepted] = await evidenceFor([
      provenRow({
        ...acknowledged,
        ackAcceptedLineNumbers: [1],
        ackRejectedLineNumbers: [],
        ackErrorCodes: [],
      }),
    ]);
    const [rejected] = await evidenceFor([
      provenRow({
        ...acknowledged,
        ackAcceptedLineNumbers: [],
        ackRejectedLineNumbers: [1],
        ackErrorCodes: [{ code: "SYNTHETIC" }],
      }),
    ]);

    expect(accepted?.disposition).toBe("SUBMISSION_EVIDENCE");
    expect(rejected?.disposition).toBe("SUBMISSION_EVIDENCE");
    expect(accepted?.sourceEvidenceFingerprint).not.toBe(rejected?.sourceEvidenceFingerprint);
  });
});
