import { describe, expect, it } from "vitest";
import { CLEAN_BODY, wrap835 } from "../../../packages/x12-835-client/__tests__/fixtures-835";
import {
  type MedicaidEraMatchStatus,
  assessMedicaidEraReview,
  matchMedicaidEraClaim,
  resolveMedicaidEraAttribution,
} from "../src/modules/25-remittance/domain/medicaid-era-trusted-review";
import type { MedicaidEraClaimCandidate } from "../src/modules/25-remittance/domain/medicaid-era-trusted-review";
import {
  header,
  parseProduction,
  setBody,
  singleSet,
  sourceFor,
  submittedCandidate,
  verifiedAttribution,
} from "./_m25-medicaid-era-fixtures";

const { raw: productionRaw, observation } = singleSet();
const verifiedProduction = () => verifiedAttribution(productionRaw);

const match = (
  candidates: readonly MedicaidEraClaimCandidate[],
  overrides: Partial<Parameters<typeof matchMedicaidEraClaim>[0]> = {},
) =>
  matchMedicaidEraClaim({
    attribution: verifiedProduction(),
    patientControlNumber: "PCN-0001",
    payerClaimControlNumber: "ICN-A1",
    serviceFrom: "2026-05-01",
    serviceTo: "2026-05-31",
    candidates,
    ...overrides,
  });

describe("production-account Medicaid ERA claim matching", () => {
  it("matches only when scope, payer, lineage, state, persisted submission, account and dates all agree", () => {
    expect(match([submittedCandidate()])).toEqual({
      status: "MATCHED",
      reasonCode: "EXACT_SCOPED_SUBMISSION_EVIDENCE",
      claimId: "claim-synthetic-1",
      submissionId: "submission-synthetic-1",
      claimVersion: 1,
    });
  });

  it("accepts an ERA service range contained in the claim range", () => {
    expect(
      match([submittedCandidate()], { serviceFrom: "2026-05-10", serviceTo: "2026-05-20" }).status,
    ).toBe("MATCHED");
  });

  const refusals: readonly {
    readonly name: string;
    readonly expected: MedicaidEraMatchStatus;
    readonly reasonCode: string;
    readonly candidates: readonly MedicaidEraClaimCandidate[];
    readonly input?: Partial<Parameters<typeof matchMedicaidEraClaim>[0]>;
  }[] = [
    {
      name: "UNMATCHED when the ERA has no patient control number",
      expected: "UNMATCHED",
      reasonCode: "CLAIM_CONTROL_MISSING",
      candidates: [submittedCandidate()],
      input: { patientControlNumber: null },
    },
    {
      name: "UNMATCHED when no claim carries the control number",
      expected: "UNMATCHED",
      reasonCode: "CLAIM_CONTROL_NOT_FOUND",
      candidates: [submittedCandidate({ claimControlNumber: "PCN-OTHER" })],
    },
    {
      name: "UNMATCHED when the only keyed claim belongs to another organization",
      expected: "UNMATCHED",
      reasonCode: "CLAIM_CONTROL_NOT_FOUND",
      candidates: [submittedCandidate({ organizationId: "org-synthetic-other" })],
    },
    {
      name: "AMBIGUOUS when two in-scope claims share the control number",
      expected: "AMBIGUOUS",
      reasonCode: "CLAIM_CONTROL_AMBIGUOUS",
      candidates: [submittedCandidate(), submittedCandidate({ claimId: "claim-synthetic-2" })],
    },
    {
      name: "PROVIDER_MISMATCH when the claim belongs to another provider entity",
      expected: "PROVIDER_MISMATCH",
      reasonCode: "CLAIM_PROVIDER_MISMATCH",
      candidates: [submittedCandidate({ providerEntityId: "provider-synthetic-2" })],
    },
    {
      name: "PAYER_MISMATCH when the claim payer differs",
      expected: "PAYER_MISMATCH",
      reasonCode: "CLAIM_PAYER_PROGRAM_MISMATCH",
      candidates: [submittedCandidate({ canonicalPayerId: "payer-synthetic-other" })],
    },
    {
      name: "PAYER_MISMATCH when the claim program differs",
      expected: "PAYER_MISMATCH",
      reasonCode: "CLAIM_PAYER_PROGRAM_MISMATCH",
      candidates: [submittedCandidate({ programId: "program-synthetic-other" })],
    },
    {
      name: "CORRECTION_LINEAGE_UNRESOLVED when replacement lineage is unresolved",
      expected: "CORRECTION_LINEAGE_UNRESOLVED",
      reasonCode: "CLAIM_REPLACEMENT_LINEAGE_UNRESOLVED",
      candidates: [submittedCandidate({ replacementLineage: "unresolved" })],
    },
    {
      name: "CLAIM_VERSION_CONFLICT for a void lineage",
      expected: "CLAIM_VERSION_CONFLICT",
      reasonCode: "CLAIM_VERSION_NOT_ACTIVE",
      candidates: [submittedCandidate({ replacementLineage: "void" })],
    },
    {
      name: "CLAIM_VERSION_CONFLICT for a replaced claim",
      expected: "CLAIM_VERSION_CONFLICT",
      reasonCode: "CLAIM_VERSION_NOT_ACTIVE",
      candidates: [submittedCandidate({ claimState: "REPLACED" })],
    },
    {
      name: "SUBMISSION_UNVERIFIED for a claim that never left the local DRAFT/READY states",
      expected: "SUBMISSION_UNVERIFIED",
      reasonCode: "CLAIM_HAS_NO_SUBMITTED_STATE",
      candidates: [submittedCandidate({ claimState: "READY" })],
    },
    {
      name: "SUBMISSION_UNVERIFIED when the submission evidence is unverified",
      expected: "SUBMISSION_UNVERIFIED",
      reasonCode: "NO_CORRELATED_EXTERNAL_SUBMISSION",
      candidates: [
        submittedCandidate({
          submission: { ...submittedCandidate().submission, status: "unverified" },
        }),
      ],
    },
    {
      name: "SUBMISSION_UNVERIFIED when the payer claim control number was never acknowledged",
      expected: "SUBMISSION_UNVERIFIED",
      reasonCode: "NO_CORRELATED_EXTERNAL_SUBMISSION",
      candidates: [
        submittedCandidate({
          submission: { ...submittedCandidate().submission, payerClaimControlNumber: null },
        }),
      ],
    },
    {
      name: "SUBMISSION_UNVERIFIED when the submitted claim version is not the candidate version",
      expected: "SUBMISSION_UNVERIFIED",
      reasonCode: "NO_CORRELATED_EXTERNAL_SUBMISSION",
      candidates: [
        submittedCandidate({
          submission: { ...submittedCandidate().submission, claimVersion: 2 },
        }),
      ],
    },
    {
      name: "SOURCE_ACCOUNT_MISMATCH when the claim was submitted through another account",
      expected: "SOURCE_ACCOUNT_MISMATCH",
      reasonCode: "SUBMISSION_SOURCE_ACCOUNT_MISMATCH",
      candidates: [
        submittedCandidate({
          submission: {
            ...submittedCandidate().submission,
            accountReference: "synthetic:account-2",
          },
        }),
      ],
    },
    {
      name: "SERVICE_RANGE_CONFLICT when the ERA range leaves the claim range",
      expected: "SERVICE_RANGE_CONFLICT",
      reasonCode: "CLAIM_SERVICE_RANGE_MISMATCH",
      candidates: [submittedCandidate()],
      input: { serviceTo: "2026-06-01" },
    },
  ];

  it.each(refusals)("$name", ({ expected, reasonCode, candidates, input }) => {
    const decision = match(candidates, input);
    expect(decision.status).toBe(expected);
    expect(decision.reasonCode).toBe(reasonCode);
  });

  it.each(refusals)(
    "never discloses claim or submission ids for $name",
    ({ candidates, input }) => {
      expect(match(candidates, input)).toMatchObject({
        claimId: null,
        submissionId: null,
        claimVersion: null,
      });
    },
  );

  it("reports NEEDS_REVIEW with the attribution hold reason when the source is not verified", () => {
    const held = resolveMedicaidEraAttribution({
      source: sourceFor(productionRaw),
      observation,
      accounts: [],
    });
    expect(
      matchMedicaidEraClaim({
        attribution: held,
        patientControlNumber: "PCN-0001",
        payerClaimControlNumber: "ICN-A1",
        serviceFrom: "2026-05-01",
        serviceTo: "2026-05-31",
        candidates: [submittedCandidate()],
      }),
    ).toEqual({
      status: "NEEDS_REVIEW",
      reasonCode: "SOURCE_ACCOUNT_UNREGISTERED",
      claimId: null,
      submissionId: null,
      claimVersion: null,
    });
  });
});

describe("claim state at the time an ERA arrives", () => {
  it.each(["PAID", "DENIED"])(
    "matches a %s claim, because a reversal or recoupment arrives after the first ERA set that state",
    (claimState) => {
      expect(match([submittedCandidate({ claimState })])).toMatchObject({
        status: "MATCHED",
        claimId: "claim-synthetic-1",
      });
    },
  );

  it.each([
    "SUBMITTED",
    "POLLING",
    "ACK_PENDING",
    "ACK_TIMEOUT",
    "ACK_ACCEPTED",
    "ACK_REJECTED",
    "ACK_PARTIAL",
  ])("matches a %s claim", (claimState) => {
    expect(match([submittedCandidate({ claimState })]).status).toBe("MATCHED");
  });

  it.each([
    "DRAFT",
    "VALIDATING",
    "FAILED_VALIDATION",
    "READY",
    "AWAITING_MEDICARE_PRIMARY",
    "FAILED_MEDICARE_PRIMARY",
  ])("refuses a %s claim as never submitted", (claimState) => {
    expect(match([submittedCandidate({ claimState })])).toMatchObject({
      status: "SUBMISSION_UNVERIFIED",
      reasonCode: "CLAIM_HAS_NO_SUBMITTED_STATE",
    });
  });

  it("names an abandoned claim as abandoned, not as never submitted", () => {
    expect(match([submittedCandidate({ claimState: "ABANDONED" })])).toMatchObject({
      status: "CLAIM_VERSION_CONFLICT",
      reasonCode: "CLAIM_ABANDONED",
      claimId: null,
    });
  });

  it("makes a reversal of a paid claim reviewable instead of unreachable", () => {
    const { observation: reversal } = singleSet([
      "BPR*H*0.00*C*NON************20260615",
      ...header(),
      "CLP*PCN-0001*22*1000.00*0.00*0.00*MC*ICN-A1",
      "DTM*232*20260501",
      "DTM*233*20260531",
      "CAS*CO*45*1000.00",
    ]);
    const assessment = assessMedicaidEraReview({
      observation: reversal,
      attribution: verifiedProduction(),
      match: match([submittedCandidate({ claimState: "PAID" })]),
      duplicate: "none",
    });
    expect(assessment).toMatchObject({
      decision: "reversal_or_recoupment_review",
      reasonCode: "PAYER_REPORTED_REVERSAL_STATUS",
      matchStatus: "MATCHED",
      postingAuthorized: false,
    });
  });
});

describe("a payer reversal of a superseded claim version", () => {
  const { observation: reversal } = singleSet([
    "BPR*H*0.00*C*NON************20260615",
    ...header(),
    "CLP*PCN-0001*22*1000.00*0.00*0.00*MC*ICN-A1",
    "DTM*232*20260501",
    "DTM*233*20260531",
    "CAS*CO*45*1000.00",
  ]);
  const assess = (candidate: MedicaidEraClaimCandidate, observed = reversal) =>
    assessMedicaidEraReview({
      observation: observed,
      attribution: verifiedProduction(),
      match: match([candidate]),
      duplicate: "none",
    });

  // The usual replacement/void flow: the provider replaces or voids a paid claim and the payer reverses the ORIGINAL
  // version. M24 no longer calls that version active, and the read seam supplies no verified submission evidence for it,
  // so it can never MATCH; the reviewer is still told it is a reversal and why it is held.
  it.each([
    ["a REPLACED original", submittedCandidate({ claimState: "REPLACED" })],
    ["a VOIDED original", submittedCandidate({ claimState: "VOIDED" })],
    ["an original with a void lineage", submittedCandidate({ replacementLineage: "void" })],
  ])("is a reversal review, held unmatched and without ids, for %s", (_name, candidate) => {
    const assessment = assess(candidate);
    expect(assessment).toMatchObject({
      decision: "reversal_or_recoupment_review",
      reasonCode: "REVERSAL_OF_SUPERSEDED_CLAIM_VERSION",
      matchStatus: "CLAIM_VERSION_CONFLICT",
      matchedClaim: null,
      claimStatusCode: 22,
      postingAuthorized: false,
    });
    expect(assessment.unresolvedRequirements).toContain("CLAIM_VERSION_NOT_ACTIVE");
  });

  it("does not turn an abandoned claim into a reversal review", () => {
    expect(assess(submittedCandidate({ claimState: "ABANDONED" }))).toMatchObject({
      decision: "unmatched_or_ambiguous",
      reasonCode: "CLAIM_ABANDONED",
      matchedClaim: null,
    });
  });

  it("does not relabel a non-reversal payment against a replaced claim", () => {
    const { observation: payment } = singleSet();
    expect(assess(submittedCandidate({ claimState: "REPLACED" }), payment)).toMatchObject({
      decision: "unmatched_or_ambiguous",
      reasonCode: "CLAIM_VERSION_NOT_ACTIVE",
      matchedClaim: null,
    });
  });

  it("does not relabel a reversal that fails to match for any other reason", () => {
    expect(assess(submittedCandidate({ canonicalPayerId: "payer-synthetic-other" }))).toMatchObject(
      {
        decision: "unmatched_or_ambiguous",
        reasonCode: "CLAIM_PAYER_PROGRAM_MISMATCH",
      },
    );
  });
});

describe("claim service dates", () => {
  const refuse = (input: Partial<Parameters<typeof matchMedicaidEraClaim>[0]>) =>
    match([submittedCandidate()], input);

  it.each([
    ["no dates at all", { serviceFrom: null, serviceTo: null }],
    ["no end date", { serviceTo: null }],
    ["no start date", { serviceFrom: null }],
  ])("names missing ERA service dates as missing, not as a mismatch (%s)", (_name, input) => {
    expect(refuse(input)).toMatchObject({
      status: "SERVICE_RANGE_CONFLICT",
      reasonCode: "ERA_SERVICE_DATES_MISSING",
    });
  });

  it.each([
    ["a malformed ERA date", { serviceFrom: "2026-5-1" }],
    ["an inverted ERA range", { serviceFrom: "2026-05-31", serviceTo: "2026-05-01" }],
    ["an impossible calendar date", { serviceTo: "2026-02-30" }],
  ])("names %s as invalid", (_name, input) => {
    expect(refuse(input)).toMatchObject({
      status: "SERVICE_RANGE_CONFLICT",
      reasonCode: "SERVICE_DATES_INVALID",
    });
  });

  it("names an invalid claim-side range as invalid", () => {
    expect(match([submittedCandidate({ serviceTo: "N/A" })])).toMatchObject({
      status: "SERVICE_RANGE_CONFLICT",
      reasonCode: "SERVICE_DATES_INVALID",
    });
  });

  it("keeps CLAIM_SERVICE_RANGE_MISMATCH for a genuine containment failure", () => {
    expect(refuse({ serviceFrom: "2026-04-30" })).toMatchObject({
      reasonCode: "CLAIM_SERVICE_RANGE_MISMATCH",
    });
  });
});

describe("assessment disclosure", () => {
  const deniedWithProviderAdjustment = () =>
    singleSet(
      setBody("50.00", [
        "CLP*PCN-0001*4*300.00*0.00*0.00*MC*ICN-A1",
        "DTM*232*20260501",
        "DTM*233*20260531",
        "CAS*CO*45*300.00",
        "PLB*1512345678*20261231*L6:REF2*-50.00",
      ]),
    );

  it("exposes the payer claim status code for an attributed, matched claim", () => {
    const { raw, observation: denied } = deniedWithProviderAdjustment();
    const attribution = verifiedAttribution(raw, denied);
    const assessment = assessMedicaidEraReview({
      observation: denied,
      attribution,
      match: matchMedicaidEraClaim({
        attribution,
        patientControlNumber: "PCN-0001",
        payerClaimControlNumber: "ICN-A1",
        serviceFrom: "2026-05-01",
        serviceTo: "2026-05-31",
        candidates: [submittedCandidate()],
      }),
      duplicate: "none",
    });
    // A provider-level adjustment in the same set outranks the claim denial in the decision; the status code keeps
    // the claim-level outcome visible to the reviewer.
    expect(assessment).toMatchObject({
      decision: "provider_adjustment_review",
      claimStatusCode: 4,
    });
  });

  it("hides the status code, amounts and structure of an unverified ERA", () => {
    const raw = wrap835(CLEAN_BODY);
    const parsed = parseProduction(raw)[0]!;
    const held = resolveMedicaidEraAttribution({
      source: sourceFor(raw),
      observation: parsed,
      accounts: [],
    });
    const assessment = assessMedicaidEraReview({
      observation: parsed,
      attribution: held,
      match: matchMedicaidEraClaim({
        attribution: held,
        patientControlNumber: "PCN-0001",
        payerClaimControlNumber: "ICN-A1",
        serviceFrom: null,
        serviceTo: null,
        candidates: [],
      }),
      duplicate: "none",
    });
    expect(parsed.claims.length).toBeGreaterThan(1);
    expect(parsed.providerAdjustments.length).toBeGreaterThan(0);
    expect(assessment.claimStatusCode).toBeNull();
    expect(assessment.unresolvedRequirements).toEqual([
      "SOURCE_ACCOUNT_UNREGISTERED",
      "PAYER_SPECIFIC_ADJUDICATION_POLICY_UNQUALIFIED",
    ]);
  });

  it("keeps the structural requirements for a verified ERA", () => {
    const raw = wrap835(CLEAN_BODY);
    const parsed = parseProduction(raw)[0]!;
    const attribution = verifiedAttribution(raw, parsed);
    const assessment = assessMedicaidEraReview({
      observation: parsed,
      attribution,
      match: matchMedicaidEraClaim({
        attribution,
        patientControlNumber: "PCN-0001",
        payerClaimControlNumber: "ICN-A1",
        serviceFrom: "2026-05-01",
        serviceTo: "2026-05-31",
        candidates: [submittedCandidate()],
      }),
      duplicate: "none",
    });
    expect(assessment.unresolvedRequirements).toEqual(
      expect.arrayContaining([
        "MULTI_CLAIM_REVIEW_REQUIRED",
        "PLB_ALLOCATION_POLICY_REQUIRED",
        "PAYER_LINE_OUTCOME_POLICY_UNQUALIFIED",
      ]),
    );
  });
});
