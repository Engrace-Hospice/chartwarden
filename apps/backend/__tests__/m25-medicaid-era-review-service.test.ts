import { describe, expect, it } from "vitest";
import { classifyIntraArtifactDuplicates } from "../src/modules/25-remittance/domain/medicaid-era-duplicate-scan";
import {
  type MedicaidEraReviewReaders,
  createMedicaidEraReviewService,
} from "../src/modules/25-remittance/domain/medicaid-era-review-service";
import { consistentMedicaidEraReviewAttribution } from "../src/modules/25-remittance/domain/medicaid-era-trusted-review";
import type { MedicaidEraAccountEvidence } from "../src/modules/25-remittance/domain/medicaid-era-trusted-review";
import {
  isTrustedAssessmentReplay,
  sameImmutableIdentity,
} from "../src/modules/25-remittance/ingest/medicaid-era-review-service";
import {
  header,
  multiSet,
  paidClaim,
  productionAccount,
  productionActor,
  setBody,
  singleSet,
  sourceFor,
  submittedCandidate,
} from "./_m25-medicaid-era-fixtures";

type Duplicate = Awaited<ReturnType<MedicaidEraReviewReaders["duplicateDecision"]>>;

const serviceFor = (
  raw: string,
  options: {
    readonly accounts?: readonly MedicaidEraAccountEvidence[];
    readonly duplicate?: Duplicate;
    readonly onDuplicateRead?: () => void;
    readonly onCandidateRead?: () => void;
    readonly accountEvidenceFingerprint?: string;
    readonly submissionEvidenceFingerprint?: string;
  } = {},
) =>
  createMedicaidEraReviewService({
    async readAuthenticatedArtifact(_actor, reference) {
      return { source: { ...sourceFor(raw), artifactReference: reference }, rawX12: raw };
    },
    async accountEvidence() {
      return (
        options.accounts ?? [
          {
            ...productionAccount,
            sourceEvidenceFingerprint:
              options.accountEvidenceFingerprint ?? productionAccount.sourceEvidenceFingerprint,
          },
        ]
      );
    },
    async duplicateDecision() {
      options.onDuplicateRead?.();
      return options.duplicate ?? "none";
    },
    async claimCandidates({ claimControlNumber }) {
      options.onCandidateRead?.();
      const suffix = claimControlNumber.slice(-1);
      const claimId = `claim-synthetic-${suffix}`;
      const base = submittedCandidate();
      return {
        candidates: [
          submittedCandidate({
            claimControlNumber,
            claimId,
            sourceEvidenceFingerprint:
              options.submissionEvidenceFingerprint ?? base.sourceEvidenceFingerprint,
            submission: {
              ...base.submission,
              claimId,
              claimControlNumber,
              payerClaimControlNumber: `ICN-A${suffix}`,
            },
          }),
        ],
        sourceEvidenceFingerprint: options.submissionEvidenceFingerprint ?? "c".repeat(64),
      };
    },
  });

const reviewOnly = async (service: ReturnType<typeof serviceFor>, actor = productionActor) => {
  const result = await service.inspect(actor, "synthetic:artifact-prod-1");
  if (result.status !== "review_only")
    throw new Error(`expected review_only, got ${result.status}`);
  return result;
};

describe("production-account review service", () => {
  it("matches a submitted claim end to end and stays nonposting", async () => {
    const { raw } = singleSet();
    const result = await reviewOnly(serviceFor(raw));
    expect(result.claims).toHaveLength(1);
    expect(result.claims[0]).toMatchObject({
      decision: "full_payment_indicated_review_required",
      matchStatus: "MATCHED",
      matchedClaim: { claimId: "claim-synthetic-1", submissionId: "submission-synthetic-1" },
      postingAuthorized: false,
    });
  });

  it("changes the snapshot digest when source evidence versions change but the decision is unchanged", async () => {
    const { raw } = singleSet();
    const original = await reviewOnly(serviceFor(raw));
    const updatedAccount = await reviewOnly(
      serviceFor(raw, { accountEvidenceFingerprint: "d".repeat(64) }),
    );
    const updatedSubmission = await reviewOnly(
      serviceFor(raw, { submissionEvidenceFingerprint: "e".repeat(64) }),
    );

    expect(updatedAccount.claims[0]?.decision).toBe(original.claims[0]?.decision);
    expect(updatedAccount.claims[0]?.matchStatus).toBe(original.claims[0]?.matchStatus);
    expect(updatedSubmission.claims[0]?.decision).toBe(original.claims[0]?.decision);
    expect(updatedSubmission.claims[0]?.matchStatus).toBe(original.claims[0]?.matchStatus);
    expect(updatedAccount.claims[0]?.evidenceSnapshotFingerprint).not.toBe(
      original.claims[0]?.evidenceSnapshotFingerprint,
    );
    expect(updatedSubmission.claims[0]?.evidenceSnapshotFingerprint).not.toBe(
      original.claims[0]?.evidenceSnapshotFingerprint,
    );
  });

  it("binds the production evaluator snapshot to account and M24 submission evidence digests", async () => {
    const { raw } = singleSet();
    const buildTrusted = (accountFingerprint: string, submissionFingerprint: string) =>
      createMedicaidEraReviewService({
        async readAuthenticatedArtifact(_actor, reference) {
          return { source: { ...sourceFor(raw), artifactReference: reference }, rawX12: raw };
        },
        async accountEvidence() {
          return [{ ...productionAccount, sourceEvidenceFingerprint: accountFingerprint }];
        },
        async duplicateDecision() {
          return "none" as const;
        },
        async claimCandidates({ claimControlNumber }) {
          const base = submittedCandidate();
          return {
            candidates: [
              submittedCandidate({
                claimControlNumber,
                sourceEvidenceFingerprint: submissionFingerprint,
                submission: {
                  ...base.submission,
                  claimControlNumber,
                  payerClaimControlNumber: "ICN-A1",
                },
              }),
            ],
            sourceEvidenceFingerprint: submissionFingerprint,
          };
        },
      });
    const original = await buildTrusted("a".repeat(64), "b".repeat(64)).inspect(
      productionActor,
      "synthetic:artifact-prod-1",
    );
    const newSourceVersion = await buildTrusted("c".repeat(64), "d".repeat(64)).inspect(
      productionActor,
      "synthetic:artifact-prod-1",
    );
    expect(original.status).toBe("review_only");
    expect(newSourceVersion.status).toBe("review_only");
    if (original.status !== "review_only" || newSourceVersion.status !== "review_only") return;
    expect(newSourceVersion.claims[0]?.decision).toBe(original.claims[0]?.decision);
    expect(newSourceVersion.claims[0]?.matchStatus).toBe(original.claims[0]?.matchStatus);
    expect(newSourceVersion.claims[0]?.evidenceSnapshotFingerprint).not.toBe(
      original.claims[0]?.evidenceSnapshotFingerprint,
    );
  });

  it("surfaces a reader-reported duplicate decision on every verified claim", async () => {
    const { raw } = singleSet();
    for (const [duplicate, decision, reasonCode] of [
      ["exact", "exact_duplicate", "EXACT_DUPLICATE_HOLD"],
      ["possible", "possible_duplicate", "POSSIBLE_DUPLICATE_HOLD"],
      ["conflict", "source_identity_conflict", "SOURCE_IDENTITY_CONFLICT_HOLD"],
    ] as const) {
      const result = await reviewOnly(serviceFor(raw, { duplicate }));
      expect(result.claims[0]).toMatchObject({ decision, reasonCode, postingAuthorized: false });
    }
  });
});

describe("durable review attribution identity", () => {
  it("accepts only claims sharing organization, provider, vendor, account, environment and payer program", async () => {
    const { raw } = singleSet();
    const result = await reviewOnly(serviceFor(raw));
    const first = result.claims[0]!;
    expect(consistentMedicaidEraReviewAttribution([first, first]).status).toBe("verified");
    for (const changed of [
      { organizationId: "other-org" },
      { providerEntityId: "other-provider" },
      { vendor: "stedi" },
      { accountReference: "other-account" },
      { usage: "test" },
      { canonicalPayerId: "other-payer" },
      { programId: "other-program" },
    ]) {
      const conflicting = {
        ...first,
        attribution: { ...first.attribution, ...changed },
      } as typeof first;
      expect(consistentMedicaidEraReviewAttribution([first, conflicting])).toEqual({
        status: "held",
        reasonCode: "MULTI_CLAIM_ATTRIBUTION_CONFLICT",
      });
    }
  });

  it("does not convert an unverified single-claim source into an attribution conflict", async () => {
    const { raw } = singleSet();
    const held = await reviewOnly(serviceFor(raw, { accounts: [] }));
    expect(consistentMedicaidEraReviewAttribution(held.claims)).toEqual({
      status: "held",
      reasonCode: "SOURCE_ACCOUNT_UNVERIFIED",
    });
  });
});

describe("persisted assessment integrity", () => {
  const identity = {
    organizationId: "synthetic-org",
    providerEntityId: "synthetic-provider",
    stageId: "synthetic-stage",
    vendor: "claimmd",
    accountReference: "synthetic-account",
    sourceEnvironment: "test",
    canonicalPayerId: "synthetic-payer",
    programId: "synthetic-program",
    sourceDigest: "a".repeat(64),
  } as const;

  it("rejects legacy fingerprint replay even when both assessment fingerprints match", () => {
    expect(
      isTrustedAssessmentReplay(
        {
          assessmentTrustStatus: "legacy_unverified",
          assessmentFingerprint: "b".repeat(64),
          assessmentEvidenceFingerprint: "c".repeat(64),
        },
        "b".repeat(64),
        "c".repeat(64),
      ),
    ).toBe(false);
  });

  it("accepts only an evaluator-trusted row with both current fingerprints", () => {
    expect(
      isTrustedAssessmentReplay(
        {
          assessmentTrustStatus: "isolated_evaluator",
          assessmentFingerprint: "b".repeat(64),
          assessmentEvidenceFingerprint: "c".repeat(64),
        },
        "b".repeat(64),
        "c".repeat(64),
      ),
    ).toBe(true);
    expect(
      isTrustedAssessmentReplay(
        {
          assessmentTrustStatus: "isolated_evaluator",
          assessmentFingerprint: "b".repeat(64),
          assessmentEvidenceFingerprint: "old-snapshot",
        },
        "b".repeat(64),
        "c".repeat(64),
      ),
    ).toBe(false);
  });

  it("compares every immutable identity dimension before legacy reassessment", () => {
    expect(sameImmutableIdentity(identity, identity)).toBe(true);
    for (const changed of [
      { organizationId: "other-org" },
      { providerEntityId: "other-provider" },
      { stageId: "other-stage" },
      { vendor: "stedi" },
      { accountReference: "other-account" },
      { sourceEnvironment: "production" },
      { canonicalPayerId: "other-payer" },
      { programId: "other-program" },
      { sourceDigest: "d".repeat(64) },
    ])
      expect(sameImmutableIdentity(identity, { ...identity, ...changed })).toBe(false);
  });
});

describe("a parseable 835 with no claim loops", () => {
  const plbOnly = () =>
    singleSet(setBody("250.00", ["PLB*1512345678*20261231*L6:REF2*-250.00"])).raw;

  it("still produces one transaction-set-level review item for a verified source", async () => {
    const result = await reviewOnly(serviceFor(plbOnly()));
    expect(result.transactionSetCount).toBe(1);
    expect(result.claims).toHaveLength(1);
    expect(result.claims[0]).toMatchObject({
      decision: "provider_adjustment_review",
      matchStatus: "NEEDS_REVIEW",
      matchedClaim: null,
      postingAuthorized: false,
      amounts: {
        claimPaidCents: null,
        providerAdjustmentCents: -25000,
        reportedPaymentCents: 25000,
      },
    });
    expect(result.claims[0]?.providerAdjustments).toEqual([
      expect.objectContaining({ reason: "L6", amountCents: -25000 }),
    ]);
    expect(result.claims[0]?.unresolvedRequirements).toContain("ERA_SET_HAS_NO_CLAIMS");
  });

  it("holds the set-level item when attribution is not verified, without exposing amounts", async () => {
    const result = await reviewOnly(serviceFor(plbOnly(), { accounts: [] }));
    expect(result.claims).toHaveLength(1);
    expect(result.claims[0]).toMatchObject({
      decision: "source_unverified",
      reasonCode: "SOURCE_ACCOUNT_UNREGISTERED",
      attributionStatus: "held",
      matchedClaim: null,
      amounts: { reportedPaymentCents: null, providerAdjustmentCents: null },
      providerAdjustments: [],
    });
  });

  it("emits a zero-dollar claimless set as a review item too, never as nothing", async () => {
    const { raw } = singleSet(["BPR*H*0.00*C*NON************20260615", ...header()]);
    const result = await reviewOnly(serviceFor(raw));
    expect(result.claims).toHaveLength(1);
    expect(result.claims[0]).toMatchObject({
      matchedClaim: null,
      postingAuthorized: false,
      amounts: { reportedPaymentCents: 0, providerAdjustmentCents: 0 },
    });
  });
});

describe("replay inside one artifact", () => {
  const twoSets = (
    first: readonly string[],
    second: readonly string[],
  ): ReturnType<typeof multiSet> =>
    multiSet([
      ["0001", first],
      ["0002", second],
    ]);
  const decisions = async (raw: string) =>
    (await reviewOnly(serviceFor(raw))).claims.map((claim) => claim.decision);

  it("holds the second of two identical sets as an exact duplicate", async () => {
    const body = setBody("1000.00", paidClaim(), "EFT-A");
    const { raw } = twoSets(body, body);
    const result = await reviewOnly(serviceFor(raw));
    expect(result.transactionSetCount).toBe(2);
    expect(result.claims.map((claim) => claim.decision)).toEqual([
      "full_payment_indicated_review_required",
      "exact_duplicate",
    ]);
    expect(result.claims[1]).toMatchObject({ reasonCode: "EXACT_DUPLICATE_HOLD" });
  });

  it("holds both sets as an identity conflict when a trace number is reused with different content", async () => {
    const { raw } = twoSets(
      setBody("1000.00", paidClaim("PCN-0001", "ICN-A1", "1000.00"), "EFT-A"),
      setBody("900.00", paidClaim("PCN-0002", "ICN-A2", "900.00"), "EFT-A"),
    );
    expect(await decisions(raw)).toEqual(["source_identity_conflict", "source_identity_conflict"]);
  });

  it("holds a later set as a possible duplicate when it repeats a payer claim control number under another trace", async () => {
    const { raw } = twoSets(
      setBody("1000.00", paidClaim("PCN-0001", "ICN-A1", "1000.00"), "EFT-A"),
      setBody("900.00", paidClaim("PCN-0009", "ICN-A1", "900.00"), "EFT-B"),
    );
    expect(await decisions(raw)).toEqual([
      "full_payment_indicated_review_required",
      "possible_duplicate",
    ]);
  });

  it("holds a later set as a possible duplicate when it repeats a nonzero payment for the same patient control number under another trace and ICN", async () => {
    const { raw } = twoSets(
      setBody("1000.00", paidClaim("PCN-0001", "ICN-A1", "1000.00"), "EFT-A"),
      setBody("1000.00", paidClaim("PCN-0001", "ICN-A2", "1000.00"), "EFT-B"),
    );
    expect(await decisions(raw)).toEqual([
      "full_payment_indicated_review_required",
      "possible_duplicate",
    ]);
  });

  it("does not hold distinct claims that are paid the same flat per-diem amount", async () => {
    const { raw } = twoSets(
      setBody("2480.00", paidClaim("PCN-0001", "ICN-A1", "2480.00"), "EFT-A"),
      setBody("2480.00", paidClaim("PCN-0002", "ICN-A2", "2480.00"), "EFT-B"),
    );
    expect(await decisions(raw)).toEqual([
      "full_payment_indicated_review_required",
      "full_payment_indicated_review_required",
    ]);
  });

  describe("a provider-adjustment-only set (no claim loops)", () => {
    const plbOnly = (trace: string, reference = "REF2", payment = "250.00") =>
      setBody(payment, [`PLB*1512345678*20261231*L6:${reference}*-${payment}`], trace);
    const verdicts = (observations: ReturnType<typeof multiSet>["observations"]) =>
      classifyIntraArtifactDuplicates(observations);
    const pair = (first: readonly string[], second: readonly string[]) =>
      verdicts(twoSets(first, second).observations);

    it("holds a replay of the same set under a new trace number as a possible duplicate", async () => {
      const { raw } = twoSets(plbOnly("T1"), plbOnly("T2"));
      expect(await decisions(raw)).toEqual(["provider_adjustment_review", "possible_duplicate"]);
    });

    it("keeps the same trace number an exact duplicate", () => {
      expect(pair(plbOnly("T1"), plbOnly("T1"))).toEqual(["none", "exact"]);
    });

    it("does not flag two sets that carry a different provider adjustment reference", () => {
      expect(pair(plbOnly("T1", "REF2"), plbOnly("T2", "REF9"))).toEqual(["none", "none"]);
    });

    it("does not flag two sets that pay a different amount", () => {
      expect(pair(plbOnly("T1"), plbOnly("T2", "REF2", "260.00"))).toEqual(["none", "none"]);
    });

    it("does not flag two sets with the same adjustment and amount but another payment date or payee", () => {
      const { observations } = twoSets(plbOnly("T1"), plbOnly("T2"));
      const [first, second] = observations as [(typeof observations)[0], (typeof observations)[0]];
      const withSource = (source: Partial<(typeof first)["source"]>) => [
        first,
        { ...second, source: { ...second.source, ...source } },
      ];
      expect(verdicts(withSource({ paymentDate: "2026-06-16" }))).toEqual(["none", "none"]);
      expect(
        verdicts(withSource({ payee: { ...second.source.payee, identifier: "1888888888" } })),
      ).toEqual(["none", "none"]);
    });

    it("does not flag repeated empty sets, which carry nothing to post twice", () => {
      const bare = (trace: string) => setBody("0.00", [], trace);
      expect(pair(bare("T1"), bare("T2"))).toEqual(["none", "none"]);
    });

    it("does not hold a claimless set against a claim set that pays the same amount", () => {
      expect(
        pair(plbOnly("T1"), setBody("250.00", paidClaim("PCN-0001", "ICN-A1", "250.00"), "T2")),
      ).toEqual(["none", "none"]);
    });
  });

  describe("a payer reversal that shares the original's claim control number", () => {
    const reversalSet = (icn: string, trace: string) =>
      [
        "BPR*H*0.00*C*NON************20260615",
        ...header(trace),
        `CLP*PCN-0001*22*1000.00*0.00*0.00*MC*${icn}`,
        "DTM*232*20260501",
        "DTM*233*20260531",
        "CAS*CO*45*1000.00",
      ] as const;

    it("stays a reversal review instead of a possible duplicate of the payment it reverses", async () => {
      const { raw } = twoSets(
        setBody("1000.00", paidClaim("PCN-0001", "ICN-A1", "1000.00"), "EFT-A"),
        reversalSet("ICN-A1", "EFT-B"),
      );
      expect(await decisions(raw)).toEqual([
        "full_payment_indicated_review_required",
        "reversal_or_recoupment_review",
      ]);
    });

    it("stays a reversal review when the reversal is listed before the payment", async () => {
      const { raw } = twoSets(
        reversalSet("ICN-A1", "EFT-B"),
        setBody("1000.00", paidClaim("PCN-0001", "ICN-A1", "1000.00"), "EFT-A"),
      );
      expect(await decisions(raw)).toEqual([
        "reversal_or_recoupment_review",
        "full_payment_indicated_review_required",
      ]);
    });

    it("still holds a second reversal of the same ICN under another trace", async () => {
      const { raw } = twoSets(reversalSet("ICN-A1", "EFT-A"), reversalSet("ICN-A1", "EFT-B"));
      expect(await decisions(raw)).toEqual(["reversal_or_recoupment_review", "possible_duplicate"]);
    });
  });

  describe("a reused trace number", () => {
    const plb = (reason: string) => `PLB*1512345678*20261231*${reason}:REF2*10.00`;
    const withPlb = (reason: string) =>
      setBody("990.00", [...paidClaim("PCN-0001", "ICN-A1", "1000.00"), plb(reason)], "EFT-A");

    it("holds the second set as an exact duplicate when the provider adjustments are identical too", async () => {
      const { raw } = twoSets(withPlb("L6"), withPlb("L6"));
      expect(await decisions(raw)).toEqual(["provider_adjustment_review", "exact_duplicate"]);
    });

    it("holds both sets as an identity conflict when only the provider adjustment reason differs", async () => {
      const { raw } = twoSets(withPlb("L6"), withPlb("72"));
      expect(await decisions(raw)).toEqual([
        "source_identity_conflict",
        "source_identity_conflict",
      ]);
    });

    it("holds both sets as an identity conflict when only a claim-level adjustment differs", async () => {
      const claimWithCas = (reason: string) =>
        setBody(
          "1000.00",
          [...paidClaim("PCN-0001", "ICN-A1", "1000.00"), `CAS*PR*${reason}*0.00`],
          "EFT-A",
        );
      const { raw } = twoSets(claimWithCas("1"), claimWithCas("2"));
      expect(await decisions(raw)).toEqual([
        "source_identity_conflict",
        "source_identity_conflict",
      ]);
    });
  });

  it("indexes the sets once instead of re-reading every earlier set for every later one", () => {
    const reads = new Map<number, number>();
    const { observations } = multiSet(
      Array.from({ length: 40 }, (_, index) => [
        String(index + 1).padStart(4, "0"),
        setBody(
          `${100 + index}.00`,
          paidClaim(`PCN-${index}`, `ICN-${index}`, `${100 + index}.00`),
          `EFT-${index}`,
        ),
      ]),
    );
    const counted = observations.map((observation, index) => ({
      ...observation,
      get claims() {
        reads.set(index, (reads.get(index) ?? 0) + 1);
        return observation.claims;
      },
    }));
    expect(classifyIntraArtifactDuplicates(counted)).toEqual(counted.map(() => "none"));
    expect(Math.max(...reads.values())).toBeLessThanOrEqual(4);
  });

  it("does not flag distinct payments", async () => {
    const { raw } = twoSets(
      setBody("1000.00", paidClaim("PCN-0001", "ICN-A1", "1000.00"), "EFT-A"),
      setBody("900.00", paidClaim("PCN-0002", "ICN-A2", "900.00"), "EFT-B"),
    );
    expect(await decisions(raw)).toEqual([
      "full_payment_indicated_review_required",
      "full_payment_indicated_review_required",
    ]);
  });

  it("does not treat equal zero-dollar payments as replays", async () => {
    const zero = (pcn: string, icn: string, trace: string) =>
      setBody(
        "0.00",
        [
          `CLP*${pcn}*4*300.00*0.00*0.00*MC*${icn}`,
          "DTM*232*20260501",
          "DTM*233*20260531",
          "CAS*CO*45*300.00",
        ],
        trace,
      );
    const { raw } = twoSets(
      zero("PCN-0001", "ICN-A1", "EFT-A"),
      zero("PCN-0002", "ICN-A2", "EFT-B"),
    );
    expect(await decisions(raw)).not.toContain("possible_duplicate");
  });

  it("keeps the stricter of the reader decision and the in-file decision", async () => {
    const body = setBody("1000.00", paidClaim(), "EFT-A");
    const { raw } = twoSets(body, body);
    const result = await reviewOnly(serviceFor(raw, { duplicate: "possible" }));
    expect(result.claims.map((claim) => claim.decision)).toEqual([
      "possible_duplicate",
      "exact_duplicate",
    ]);
    const conflict = await reviewOnly(serviceFor(raw, { duplicate: "conflict" }));
    expect(conflict.claims.map((claim) => claim.decision)).toEqual([
      "source_identity_conflict",
      "source_identity_conflict",
    ]);
  });

  it("does not run duplicate or claim reads for an unattributed set", async () => {
    const body = setBody("1000.00", paidClaim(), "EFT-A");
    const { raw } = twoSets(body, body);
    let duplicateReads = 0;
    let candidateReads = 0;
    const result = await reviewOnly(
      serviceFor(raw, {
        accounts: [],
        onDuplicateRead: () => duplicateReads++,
        onCandidateRead: () => candidateReads++,
      }),
    );
    expect(result.claims.map((claim) => claim.decision)).toEqual([
      "source_unverified",
      "source_unverified",
    ]);
    expect(duplicateReads + candidateReads).toBe(0);
  });
});

describe("tenant isolation of account evidence", () => {
  const { raw } = singleSet();
  const expiredAccount: MedicaidEraAccountEvidence = {
    ...productionAccount,
    enrollment: "expired",
  };
  const otherActor = { ...productionActor, organizationId: "org-synthetic-other" };

  it("returns unavailable, not another tenant's hold reason, for a held foreign account", async () => {
    let candidateReads = 0;
    const service = serviceFor(raw, {
      accounts: [expiredAccount],
      onCandidateRead: () => candidateReads++,
    });
    expect(await service.inspect(otherActor, "synthetic:artifact-prod-1")).toEqual({
      status: "unavailable",
      reasonCode: "SOURCE_ARTIFACT_UNAVAILABLE",
    });
    expect(candidateReads).toBe(0);
  });

  it("returns unavailable for a verified foreign account", async () => {
    expect(await serviceFor(raw).inspect(otherActor, "synthetic:artifact-prod-1")).toEqual({
      status: "unavailable",
      reasonCode: "SOURCE_ARTIFACT_UNAVAILABLE",
    });
  });

  it("returns unavailable when the account belongs to a provider entity outside the actor's scope", async () => {
    const service = serviceFor(raw, { accounts: [expiredAccount] });
    expect(
      await service.inspect(
        { ...productionActor, providerEntityScope: ["provider-synthetic-other"] },
        "synthetic:artifact-prod-1",
      ),
    ).toEqual({ status: "unavailable", reasonCode: "SOURCE_ARTIFACT_UNAVAILABLE" });
  });

  it("ignores another tenant's evidence for the same account instead of calling it ambiguous", async () => {
    const result = await reviewOnly(
      serviceFor(raw, {
        accounts: [
          { ...productionAccount, organizationId: "org-synthetic-other", enrollment: "revoked" },
          productionAccount,
        ],
      }),
    );
    expect(result.claims[0]).toMatchObject({
      attributionStatus: "verified",
      attribution: { organizationId: "org-synthetic-1" },
    });
  });

  describe("sibling provider entities on one vendor account", () => {
    const entityB: MedicaidEraAccountEvidence = {
      ...productionAccount,
      providerEntityId: "provider-synthetic-2",
      billingNpi: "1888888888",
      evidenceReference: "synthetic:evidence-2",
    };
    const narrowActor = { ...productionActor, providerEntityScope: ["provider-synthetic-1"] };
    const eraFor = (npi: string) =>
      raw.replace("N1*PE*SYNTH HOSPICE*XX*1999999999", `N1*PE*SYNTH HOSPICE*XX*${npi}`);

    it("reads as unavailable, not as a payee conflict, when the ERA is addressed to an out-of-scope sibling", async () => {
      let candidateReads = 0;
      const service = serviceFor(eraFor("1888888888"), {
        accounts: [productionAccount, entityB],
        onCandidateRead: () => candidateReads++,
      });
      expect(await service.inspect(narrowActor, "synthetic:artifact-prod-1")).toEqual({
        status: "unavailable",
        reasonCode: "SOURCE_ARTIFACT_UNAVAILABLE",
      });
      expect(candidateReads).toBe(0);
    });

    it("answers the same way for an out-of-scope sibling of another organization", async () => {
      const service = serviceFor(eraFor("1888888888"), {
        accounts: [productionAccount, { ...entityB, organizationId: "org-synthetic-other" }],
      });
      expect(await service.inspect(narrowActor, "synthetic:artifact-prod-1")).toEqual({
        status: "unavailable",
        reasonCode: "SOURCE_ARTIFACT_UNAVAILABLE",
      });
    });

    const unavailable = { status: "unavailable", reasonCode: "SOURCE_ARTIFACT_UNAVAILABLE" };

    it("answers a payee that matches nobody exactly like a payee that matches the hidden sibling", async () => {
      for (const npi of ["1888888888", "1777777777"]) {
        const service = serviceFor(eraFor(npi), { accounts: [productionAccount, entityB] });
        expect(await service.inspect(narrowActor, "synthetic:artifact-prod-1")).toEqual(
          unavailable,
        );
      }
    });

    it("treats a hidden sibling of another organization or with a lapsed enrollment as a hidden sibling too", async () => {
      for (const sibling of [
        { ...entityB, organizationId: "org-synthetic-other" },
        { ...entityB, enrollment: "revoked" as const },
      ]) {
        const service = serviceFor(eraFor("1777777777"), {
          accounts: [productionAccount, sibling],
        });
        expect(await service.inspect(narrowActor, "synthetic:artifact-prod-1")).toEqual(
          unavailable,
        );
      }
    });

    it("still holds a payee that matches nobody as a payee conflict when the account has no hidden sibling", async () => {
      const result = await reviewOnly(
        serviceFor(eraFor("1777777777"), { accounts: [productionAccount] }),
        narrowActor,
      );
      expect(result.claims[0]).toMatchObject({
        decision: "source_unverified",
        reasonCode: "PAYEE_IDENTITY_CONFLICT",
      });
    });

    it("reads a payee identified by tax id as unavailable beside a hidden sibling, and as a payee conflict without one", async () => {
      const taxIdEra = raw.replace("XX*1999999999", "FI*123456789");
      expect(
        await serviceFor(taxIdEra, {
          accounts: [productionAccount, { ...entityB, billingNpi: "" }],
        }).inspect(narrowActor, "synthetic:artifact-prod-1"),
      ).toEqual(unavailable);
      const result = await reviewOnly(
        serviceFor(taxIdEra, { accounts: [productionAccount] }),
        narrowActor,
      );
      expect(result.claims[0]).toMatchObject({
        decision: "source_unverified",
        reasonCode: "PAYEE_IDENTITY_CONFLICT",
      });
    });

    it("reviews the actor's own entity even when a sibling shares the billing NPI", async () => {
      const result = await reviewOnly(
        serviceFor(raw, {
          accounts: [productionAccount, { ...entityB, billingNpi: "1999999999" }],
        }),
        narrowActor,
      );
      expect(result.claims[0]).toMatchObject({
        attributionStatus: "verified",
        attribution: { providerEntityId: "provider-synthetic-1" },
      });
    });

    it("lets an actor whose scope covers the sibling review the ERA addressed to it", async () => {
      const result = await reviewOnly(
        serviceFor(eraFor("1888888888"), { accounts: [productionAccount, entityB] }),
        {
          ...productionActor,
          providerEntityScope: ["provider-synthetic-1", "provider-synthetic-2"],
        },
      );
      expect(result.claims[0]).toMatchObject({
        attributionStatus: "verified",
        attribution: { providerEntityId: "provider-synthetic-2" },
      });
    });
  });

  it("still holds an in-tenant account that is not registered at all", async () => {
    const result = await reviewOnly(serviceFor(raw, { accounts: [] }));
    expect(result.claims[0]).toMatchObject({
      decision: "source_unverified",
      reasonCode: "SOURCE_ACCOUNT_UNREGISTERED",
    });
  });
});
