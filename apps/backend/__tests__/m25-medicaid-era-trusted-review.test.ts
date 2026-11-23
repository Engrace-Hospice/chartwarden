import { createHash } from "node:crypto";
import { parseX12835AllSets } from "@chartwarden/x12-835-client";
import { describe, expect, it } from "vitest";
import { CLEAN_BODY, wrap835 } from "../../../packages/x12-835-client/__tests__/fixtures-835";
import { observeParsedMedicaidEra } from "../src/modules/25-remittance/domain/medicaid-era-observation";
import { createMedicaidEraReviewService } from "../src/modules/25-remittance/domain/medicaid-era-review-service";
import {
  type AuthenticatedMedicaidEraSource,
  type MedicaidEraAccountEvidence,
  type MedicaidEraClaimCandidate,
  assessMedicaidEraReview,
  matchMedicaidEraClaim,
  resolveMedicaidEraAttribution,
} from "../src/modules/25-remittance/domain/medicaid-era-trusted-review";

const parsed = () => {
  const result = parseX12835AllSets(wrap835(CLEAN_BODY, { isa15: "T" }), "medicaid", {
    allowTestFiles: true,
  });
  if (!result.ok) throw new Error(result.degraded.code);
  return result.value[0]!;
};

const rawX12 = wrap835(CLEAN_BODY, { isa15: "T" });
const source: AuthenticatedMedicaidEraSource = {
  vendor: "claimmd",
  accountReference: "synthetic:account-1",
  usage: "test",
  artifactReference: "synthetic:artifact-1",
  artifactDigest: createHash("sha256").update(rawX12, "utf8").digest("hex"),
  receivedAt: "2026-11-22T12:00:00.000Z",
};
const actor = {
  organizationId: "org-synthetic-1",
  userId: "synthetic-user-1",
  roles: ["billing_staff"],
  providerEntityScope: ["provider-synthetic-1"],
} as const;

const account: MedicaidEraAccountEvidence = {
  organizationId: "org-synthetic-1",
  providerEntityId: "provider-synthetic-1",
  vendor: "claimmd",
  accountReference: "synthetic:account-1",
  usage: "test",
  canonicalPayerId: "payer-synthetic-oregon",
  programId: "program-synthetic-oregon-ccp",
  acceptedPayerIdentifiers: [{ qualifier: "XV", identifier: "99999" }],
  billingNpi: "1999999999",
  billingTin: null,
  enrollment: "verified_active",
  effectiveFrom: "2026-01-01",
  effectiveTo: null,
  evidenceReference: "synthetic:evidence-1",
  verifiedAt: "2026-11-20T00:00:00.000Z",
  evidenceFreshUntil: "2026-12-20T00:00:00.000Z",
};

describe("trusted Medicaid ERA review contract", () => {
  it("attributes only an exact authenticated account, environment, payer and payee combination", () => {
    const observation = observeParsedMedicaidEra(parsed());
    expect(
      resolveMedicaidEraAttribution({ source, observation, accounts: [account] }),
    ).toMatchObject({
      status: "verified",
      organizationId: account.organizationId,
      providerEntityId: account.providerEntityId,
      canonicalPayerId: account.canonicalPayerId,
      usage: "test",
    });
    expect(
      resolveMedicaidEraAttribution({
        source: { ...source, usage: "production" },
        observation,
        accounts: [account],
      }),
    ).toEqual({ status: "held", reason: "SOURCE_ACCOUNT_UNREGISTERED" });
    expect(
      resolveMedicaidEraAttribution({
        source,
        observation,
        accounts: [
          {
            ...account,
            acceptedPayerIdentifiers: [{ qualifier: "XV", identifier: "other-payer" }],
          },
        ],
      }),
    ).toEqual({ status: "held", reason: "PAYER_IDENTITY_UNVERIFIED" });
    expect(
      resolveMedicaidEraAttribution({
        source,
        observation,
        accounts: [
          { ...account, acceptedPayerIdentifiers: [{ qualifier: "FI", identifier: "99999" }] },
        ],
      }),
    ).toEqual({ status: "held", reason: "PAYER_IDENTITY_UNVERIFIED" });
    expect(
      resolveMedicaidEraAttribution({ source, observation, accounts: [account, account] }),
    ).toEqual({ status: "held", reason: "SOURCE_ACCOUNT_AMBIGUOUS" });
    expect(
      resolveMedicaidEraAttribution({
        source,
        observation,
        accounts: [{ ...account, enrollment: "expired" }],
      }),
    ).toEqual({ status: "held", reason: "ENROLLMENT_NOT_ACTIVE" });
    expect(
      resolveMedicaidEraAttribution({
        source,
        observation: {
          ...observation,
          source: {
            ...observation.source,
            payee: { ...observation.source.payee, identifier: "1888888888" },
          },
        },
        accounts: [account],
      }),
    ).toEqual({ status: "held", reason: "PAYEE_IDENTITY_CONFLICT" });
    expect(
      resolveMedicaidEraAttribution({
        source,
        observation: {
          ...observation,
          source: {
            ...observation.source,
            payee: { ...observation.source.payee, taxIdentifier: "123456789" },
          },
        },
        accounts: [account],
      }),
    ).toEqual({ status: "held", reason: "PAYEE_IDENTITY_CONFLICT" });
  });

  it("refuses test fixtures before a candidate can be treated as a local DRAFT or READY submission", () => {
    const observation = observeParsedMedicaidEra(parsed());
    const attribution = resolveMedicaidEraAttribution({ source, observation, accounts: [account] });
    if (attribution.status !== "verified") throw new Error("fixture attribution failed");
    const candidate: MedicaidEraClaimCandidate = {
      organizationId: attribution.organizationId,
      providerEntityId: attribution.providerEntityId,
      claimId: "claim-synthetic-1",
      canonicalPayerId: attribution.canonicalPayerId,
      programId: attribution.programId,
      claimControlNumber: "PCN-0001",
      serviceFrom: "2026-11-01",
      serviceTo: "2026-11-01",
      claimVersion: 1,
      claimState: "READY",
      replacementLineage: "original",
      submission: {
        status: "missing",
        submissionId: null,
        claimId: null,
        claimVersion: null,
        claimControlNumber: null,
        payerClaimControlNumber: null,
        vendor: null,
        accountReference: null,
        transactionReference: null,
      },
    };
    const match = matchMedicaidEraClaim({
      attribution,
      patientControlNumber: "PCN-0001",
      payerClaimControlNumber: "ICN-A1",
      serviceFrom: "2026-11-01",
      serviceTo: "2026-11-01",
      candidates: [candidate],
    });
    expect(match).toMatchObject({
      status: "SUBMISSION_UNVERIFIED",
      reasonCode: "TEST_ERA_CANNOT_MATCH_PRODUCTION_CLAIM",
      claimId: null,
    });
    const assessment = assessMedicaidEraReview({
      observation,
      attribution,
      match,
      duplicate: "none",
    });
    expect(assessment).toMatchObject({
      decision: "unmatched_or_ambiguous",
      matchStatus: "SUBMISSION_UNVERIFIED",
      matchedClaim: null,
      postingAuthorized: false,
    });
  });

  it("fails closed on test-mode evidence even when candidate claim identifiers look exact", () => {
    const observation = observeParsedMedicaidEra(parsed());
    const attribution = resolveMedicaidEraAttribution({ source, observation, accounts: [account] });
    if (attribution.status !== "verified") throw new Error("synthetic fixture attribution failed");
    expect(
      matchMedicaidEraClaim({
        attribution,
        patientControlNumber: "PCN-0001",
        payerClaimControlNumber: "ICN-A1",
        serviceFrom: "2026-11-01",
        serviceTo: "2026-11-01",
        candidates: [],
      }),
    ).toMatchObject({
      status: "SUBMISSION_UNVERIFIED",
      reasonCode: "TEST_ERA_CANNOT_MATCH_PRODUCTION_CLAIM",
      claimId: null,
    });
  });

  it("holds an artifact when its digest does not match the staged bytes", async () => {
    const service = createMedicaidEraReviewService({
      async readAuthenticatedArtifact(_actor, reference) {
        return {
          source: { ...source, artifactReference: reference, artifactDigest: "f".repeat(64) },
          rawX12,
        };
      },
      async accountEvidence() {
        return [account];
      },
      async duplicateDecision() {
        return "none";
      },
      async claimCandidates() {
        return [];
      },
    });
    expect(await service.inspect(actor, source.artifactReference)).toEqual({
      status: "held",
      reasonCode: "SOURCE_ARTIFACT_DIGEST_MISMATCH",
      postingAuthorized: false,
    });
  });

  it("keeps ERA outcomes review-only and preserves missing amounts", () => {
    const observation = observeParsedMedicaidEra(parsed());
    const attribution = { status: "held", reason: "SOURCE_ACCOUNT_UNREGISTERED" } as const;
    const match = {
      status: "NEEDS_REVIEW",
      reasonCode: "SOURCE_ACCOUNT_UNREGISTERED",
      claimId: null,
      submissionId: null,
      claimVersion: null,
    } as const;
    const assessment = assessMedicaidEraReview({
      observation,
      attribution,
      match,
      duplicate: "none",
    });
    expect(assessment.decision).toBe("source_unverified");
    expect(assessment.postingAuthorized).toBe(false);
    expect(assessment.amounts.claimPaidCents).toBeNull();
    expect(assessment.matchedClaim).toBeNull();
    expect(assessment.amounts.reportedPaymentCents).toBeNull();
    expect(assessment.amounts.providerAdjustmentCents).toBeNull();
    expect(assessment.providerAdjustments).toEqual([]);
    expect(assessment.claimAdjustments).toEqual([]);
    expect(assessment.serviceLineAdjustments).toEqual([]);
    const verifiedTestAttribution = resolveMedicaidEraAttribution({
      source,
      observation,
      accounts: [account],
    });
    const safelySummed = assessMedicaidEraReview({
      observation: {
        ...observation,
        providerAdjustments: [
          { reason: "synthetic", reference: null, amountCents: Number.MAX_SAFE_INTEGER },
          { reason: "synthetic", reference: null, amountCents: 1 },
        ],
      },
      attribution: verifiedTestAttribution,
      match,
      duplicate: "none",
    });
    expect(safelySummed.amounts.providerAdjustmentCents).toBeNull();
    expect(safelySummed.providerAdjustments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: expect.any(String), amountCents: expect.any(Number) }),
      ]),
    );
    expect(safelySummed.serviceLineAdjustments.length).toBeGreaterThan(0);
  });

  it("re-reads an opaque staged artifact and returns a nonposting server assessment", async () => {
    let candidateReads = 0;
    const service = createMedicaidEraReviewService({
      async readAuthenticatedArtifact(_actor, reference) {
        return {
          source: { ...source, artifactReference: reference },
          rawX12,
        };
      },
      async accountEvidence() {
        return [account];
      },
      async duplicateDecision() {
        return "none";
      },
      async claimCandidates() {
        candidateReads++;
        return [];
      },
    });
    const result = await service.inspect(actor, "synthetic:artifact-1");
    expect(result.status).toBe("review_only");
    if (result.status !== "review_only") throw new Error("expected review projection");
    expect(result.claims).toHaveLength(3);
    expect(result.claims).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ decision: "unmatched_or_ambiguous", postingAuthorized: false }),
      ]),
    );
    expect(result.claims[0]).toMatchObject({
      attribution: { usage: "test", organizationId: account.organizationId },
      decision: "unmatched_or_ambiguous",
      matchStatus: "SUBMISSION_UNVERIFIED",
    });
    const crossTenant = await service.inspect(
      { ...actor, organizationId: "other-tenant" },
      "synthetic:artifact-1",
    );
    expect(crossTenant).toEqual({
      status: "unavailable",
      reasonCode: "SOURCE_ARTIFACT_UNAVAILABLE",
    });
    expect(candidateReads).toBe(0);
  });
});
