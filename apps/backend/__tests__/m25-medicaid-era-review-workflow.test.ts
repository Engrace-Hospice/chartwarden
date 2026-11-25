// Synthetic fixtures only (NO PHI). Unit coverage of the Medicaid ERA review workflow pieces that sit between the
// assessment service and the writer: claim-candidate selection, the stored duplicate status and the signed list
// cursor.
import {
  InvalidCursorError,
  decodeKeysetCursor,
  encodeCursor,
} from "@chartwarden/shared/route-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { __resetSeamsForTest, registerSeam } from "../src/bootstrap/seams/registry";
import {
  type MedicaidEraReviewReaders,
  createMedicaidEraReviewService,
} from "../src/modules/25-remittance/domain/medicaid-era-review-service";
import { matchMedicaidEraClaim } from "../src/modules/25-remittance/domain/medicaid-era-trusted-review";
import {
  buildDrizzleMedicaidEraReviewReaders,
  provingAttemptOf,
} from "../src/modules/25-remittance/ingest/medicaid-era-review-readers";
import {
  assertAttestedReview,
  buildDrizzleMedicaidEraReviewWorkflow,
  duplicateStatusOf,
} from "../src/modules/25-remittance/ingest/medicaid-era-review-service";
import type { MedicaidSubmissionEvidenceView } from "../src/modules/25-remittance/routes/medicaid-claim-facts";
import {
  header,
  multiSet,
  paidClaim,
  productionAccount,
  productionActor,
  setBody,
  singleSet,
  sourceFor,
  verifiedAttribution,
} from "./_m25-medicaid-era-fixtures";

type Attempt = MedicaidSubmissionEvidenceView["attempts"][number];

const qualifyingAttempt = (overrides: Partial<Attempt> = {}): Attempt => ({
  submissionId: "submission-synthetic-2",
  attemptIndex: 2,
  claimVersion: 1,
  sourceAccountRef: "synthetic:account-1",
  environment: "production",
  vendor: "claimmd",
  vendorTransactionId: "vendor-tx-synthetic-2",
  payerId: "payer-synthetic-oregon",
  payerClassificationId: "program-synthetic-oregon-ccp",
  programKind: "ccp",
  assignmentId: "assignment-synthetic-1",
  assignmentVersion: 1,
  provenanceStatus: "verified",
  result: "accepted_sync",
  submittedAt: "2026-06-02T00:00:00.000Z",
  acknowledgments: [
    {
      id: "ack-synthetic-1",
      kind: "277CA",
      outcome: "accepted",
      payerClaimControlNumber: "ICN-A1",
      receivedAt: "2026-06-03T00:00:00.000Z",
    },
  ],
  ...overrides,
});

/** A transport failure or rejection that preceded the resubmission: verified provenance, but not proof of anything. */
const rejectedAttempt = (overrides: Partial<Attempt> = {}): Attempt =>
  qualifyingAttempt({
    submissionId: "submission-synthetic-1",
    attemptIndex: 1,
    vendorTransactionId: "vendor-tx-synthetic-1",
    result: "rejected_sync",
    acknowledgments: [],
    ...overrides,
  });

const submissionFact = (
  attempts: readonly Attempt[],
  overrides: Partial<MedicaidSubmissionEvidenceView> = {},
): MedicaidSubmissionEvidenceView => ({
  disposition: "SUBMISSION_EVIDENCE",
  sourceEvidenceFingerprint: "a".repeat(64),
  claimId: "claim-synthetic-1",
  organizationId: "org-synthetic-1",
  providerEntityId: "provider-synthetic-1",
  claimControlNumber: "PCN-0001",
  canonicalPayerId: "payer-synthetic-oregon",
  programKind: "ccp",
  serviceState: "OR",
  serviceFrom: "2026-05-01",
  serviceTo: "2026-05-31",
  claimState: "ACK_ACCEPTED",
  claimVersion: 1,
  replacesClaimId: null,
  replacedByClaimId: null,
  attempts,
  ...overrides,
});

describe("claim candidates for a claim that was resubmitted", () => {
  afterEach(() => __resetSeamsForTest());

  const candidatesFor = async (facts: readonly MedicaidSubmissionEvidenceView[]) => {
    registerSeam("MedicaidClaimMatchProvider", {
      submissionEvidenceForLine: async () => [...facts],
    } as never);
    const readers = buildDrizzleMedicaidEraReviewReaders({} as never);
    const { candidates } = await readers.claimCandidates({
      actor: productionActor,
      organizationId: "org-synthetic-1",
      providerEntityId: "provider-synthetic-1",
      claimControlNumber: "PCN-0001",
    });
    return candidates;
  };

  it("keeps the claim the seam proved when an earlier attempt was rejected, and matches its ERA", async () => {
    const [candidate] = await candidatesFor([
      submissionFact([rejectedAttempt(), qualifyingAttempt()]),
    ]);
    expect(candidate).toMatchObject({
      claimId: "claim-synthetic-1",
      submission: {
        status: "verified_submitted",
        submissionId: "submission-synthetic-2",
        transactionReference: "vendor-tx-synthetic-2",
        payerClaimControlNumber: "ICN-A1",
      },
    });
    const { raw, observation } = singleSet();
    const claim = observation.claims[0]!;
    expect(
      matchMedicaidEraClaim({
        attribution: verifiedAttribution(raw),
        patientControlNumber: claim.patientControlNumber,
        payerClaimControlNumber: claim.payerClaimControlNumber,
        serviceFrom: claim.serviceFrom,
        serviceTo: claim.serviceTo,
        candidates: candidate ? [candidate] : [],
      }),
    ).toMatchObject({ status: "MATCHED", submissionId: "submission-synthetic-2" });
  });

  it("selects the same attempt whatever order the attempts arrive in", async () => {
    const [candidate] = await candidatesFor([
      submissionFact([qualifyingAttempt(), rejectedAttempt({ result: "transport_failure" })]),
    ]);
    expect(candidate?.submission.submissionId).toBe("submission-synthetic-2");
  });

  it("offers no candidate when two attempts would both prove the claim", async () => {
    expect(
      await candidatesFor([
        submissionFact([
          qualifyingAttempt(),
          qualifyingAttempt({ submissionId: "submission-synthetic-3", attemptIndex: 3 }),
        ]),
      ]),
    ).toEqual([]);
  });

  it("offers no candidate for a fact the seam did not prove", async () => {
    expect(
      await candidatesFor([
        submissionFact([qualifyingAttempt()], {
          disposition: "SUBMISSION_UNVERIFIED",
          claimId: null,
        }),
      ]),
    ).toEqual([]);
  });
});

describe("the attempt that proves a claim", () => {
  const prove = (...attempts: Attempt[]) => provingAttemptOf(submissionFact(attempts));

  it.each([
    ["unverified provenance", { provenanceStatus: "unverified" }],
    ["a test environment", { environment: "test" }],
    ["a rejected result", { result: "rejected_sync" }],
    ["a timeout", { result: "timeout" }],
    ["another claim version", { claimVersion: 2 }],
    ["no submission id", { submissionId: null }],
    ["no vendor transaction id", { vendorTransactionId: null }],
    ["no payer classification", { payerClassificationId: null }],
    ["another payer than the claim's", { payerId: "payer-synthetic-other" }],
    ["another program kind than the claim's", { programKind: "ffs_open_card" }],
    ["no source account", { sourceAccountRef: null }],
    ["no send time", { submittedAt: null }],
  ] as const)("does not count an attempt with %s", (_label, override) => {
    expect(prove(qualifyingAttempt(override))).toBeNull();
  });

  it("is not made ambiguous by a second attempt the seam would not qualify", () => {
    const other = qualifyingAttempt({
      submissionId: "submission-synthetic-9",
      attemptIndex: 9,
      payerId: "payer-synthetic-other",
    });
    expect(prove(qualifyingAttempt(), other)?.submissionId).toBe("submission-synthetic-2");
  });

  it("counts a pending asynchronous submission", () => {
    expect(prove(qualifyingAttempt({ result: "pending_async" }))).not.toBeNull();
  });
});

describe("the stored assessment projection", () => {
  type Duplicate = Awaited<ReturnType<MedicaidEraReviewReaders["duplicateDecision"]>>;
  const reviewOnly = async (raw: string, duplicate: Duplicate = "none") => {
    const result = await createMedicaidEraReviewService({
      readAuthenticatedArtifact: async (_actor, reference) => ({
        source: { ...sourceFor(raw), artifactReference: reference },
        rawX12: raw,
      }),
      accountEvidence: async () => [productionAccount],
      duplicateDecision: async () => duplicate,
      claimCandidates: async () => ({
        candidates: [],
        sourceEvidenceFingerprint: "0".repeat(64),
      }),
    }).inspect(productionActor, "synthetic:artifact-prod-1");
    if (result.status !== "review_only")
      throw new Error(`expected review_only, got ${result.status}`);
    return result;
  };

  it("carries the artifact reference and digest the workflow binds the review to", async () => {
    const { raw } = singleSet();
    const result = await reviewOnly(raw);
    expect(result.artifactReference).toBe("synthetic:artifact-prod-1");
    expect(result.artifactDigest).toBe(sourceFor(raw).artifactDigest);
  });

  it("keeps the payer's claim status code per claim, so an unmatched reversal stays visible", async () => {
    const reversal = [
      "BPR*H*0.00*C*NON************20260615",
      ...header(),
      "CLP*PCN-0001*22*1000.00*0.00*0.00*MC*ICN-A1",
      "DTM*232*20260501",
      "DTM*233*20260531",
      "CAS*CO*45*1000.00",
    ];
    const { raw } = singleSet(reversal);
    const result = await reviewOnly(raw);
    expect(result.claims[0]).toMatchObject({
      decision: "unmatched_or_ambiguous",
      claimStatusCode: 22,
    });
  });

  it.each([
    ["none", "none"],
    ["possible", "possible"],
    ["exact", "exact"],
    ["conflict", "conflict"],
  ] as const)("stores a reader-reported %s duplicate as %s", async (duplicate, stored) => {
    const { raw } = singleSet();
    const result = await reviewOnly(raw, duplicate);
    expect(duplicateStatusOf(result.claims)).toBe(stored);
  });

  it("stores the strictest duplicate decision, not the first one it meets", async () => {
    const body = setBody("1000.00", paidClaim(), "EFT-A");
    const { raw } = multiSet([
      ["0001", body],
      ["0002", body],
    ]);
    const result = await reviewOnly(raw, "possible");
    expect(result.claims.map((claim) => claim.decision)).toEqual([
      "possible_duplicate",
      "exact_duplicate",
    ]);
    expect(duplicateStatusOf(result.claims)).toBe("exact");
  });

  it("ranks conflict over exact over possible", () => {
    const claims = (...decisions: string[]) => decisions.map((decision) => ({ decision })) as never;
    expect(duplicateStatusOf(claims("possible_duplicate", "exact_duplicate"))).toBe("exact");
    expect(duplicateStatusOf(claims("exact_duplicate", "source_identity_conflict"))).toBe(
      "conflict",
    );
    expect(duplicateStatusOf(claims("payment_reported", "denial"))).toBe("none");
  });
});

describe("actions on a review", () => {
  it("refuses a note or disposition on a review that predates evaluator attestation", () => {
    expect(() => assertAttestedReview({ assessmentTrustStatus: "legacy_unverified" })).toThrow(
      /predates evaluator attestation/,
    );
    expect(() =>
      assertAttestedReview({ assessmentTrustStatus: "isolated_evaluator" }),
    ).not.toThrow();
  });
});

describe("the review workflow", () => {
  const unusedDb = {} as never;
  const inspect = vi.fn();
  const workflow = buildDrizzleMedicaidEraReviewWorkflow(unusedDb, { inspect });

  describe("list cursor", () => {
    const row = (index: number) => ({
      id: `00000000-0000-4000-8000-00000000000${index}`,
      createdAt: new Date(`2026-11-2${index}T10:00:00.123Z`),
      // What `created_at::text` returns: microseconds the Date above cannot hold.
      sortTs: `2026-11-2${index} 10:00:00.123456+00`,
      assessmentTrustStatus: "legacy_unverified",
    });
    const dbReturning = (rows: readonly object[]) =>
      ({
        transaction: async (run: (tx: unknown) => unknown) =>
          run({
            execute: async () => [],
            select: () => ({
              from: () => ({
                where: () => ({ orderBy: () => ({ limit: async () => rows }) }),
              }),
            }),
          }),
      }) as never;

    it("signs the next-page cursor for the organization and accepts it back", async () => {
      const page = await buildDrizzleMedicaidEraReviewWorkflow(
        dbReturning([row(3), row(2), row(1)]),
        {
          inspect,
        },
      ).list(productionActor, 2);
      expect(
        decodeKeysetCursor(productionActor.organizationId, page.nextCursor, "instant"),
      ).toEqual({
        a: row(2).sortTs,
        id: row(2).id,
      });
      await expect(
        buildDrizzleMedicaidEraReviewWorkflow(dbReturning([row(1)]), { inspect }).list(
          productionActor,
          2,
          page.nextCursor ?? undefined,
        ),
      ).resolves.toMatchObject({ nextCursor: null });
    });

    it("rejects an unsigned cursor, a tampered one and another organization's", async () => {
      const own = encodeCursor(productionActor.organizationId, {
        a: row(2).createdAt.toISOString(),
        id: row(2).id,
      });
      const legacyUnsigned = Buffer.from(`${row(2).createdAt.toISOString()}|${row(2).id}`).toString(
        "base64url",
      );
      const [body, signature] = own.split(".") as [string, string];
      const foreign = encodeCursor("org-synthetic-other", {
        a: row(2).createdAt.toISOString(),
        id: row(2).id,
      });
      for (const cursor of [legacyUnsigned, `${body}.${signature.slice(1)}x`, `x${own}`, foreign]) {
        await expect(workflow.list(productionActor, 10, cursor)).rejects.toBeInstanceOf(
          InvalidCursorError,
        );
      }
    });
  });
});
