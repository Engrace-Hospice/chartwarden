import { parseX12835AllSets } from "@chartwarden/x12-835-client";
import { describe, expect, it } from "vitest";
import {
  CLEAN_BODY,
  wrap835,
  wrap835Sets,
} from "../../../packages/x12-835-client/__tests__/fixtures-835";
import { observeParsedMedicaidEra } from "../src/modules/25-remittance/domain/medicaid-era-observation";
import {
  planClaimMdTestEraRetrieval,
  planStediTestEraRetrieval,
} from "../src/modules/25-remittance/domain/medicaid-era-offline-contracts";
import { classifyClaimMdEraCrossSourceDuplicate } from "../src/modules/25-remittance/ingest/claimmd-era-duplicate";

const parse = (raw: string) => {
  const result = parseX12835AllSets(raw, "medicaid", { allowTestFiles: true });
  if (!result.ok) throw new Error(result.degraded.code);
  return result.value;
};

type SyntheticMatch =
  | "MATCHED"
  | "UNMATCHED"
  | "AMBIGUOUS"
  | "PAYER_MISMATCH"
  | "PROVIDER_MISMATCH"
  | "SOURCE_UNVERIFIED"
  | "SUBMISSION_UNVERIFIED"
  | "DUPLICATE"
  | "NEEDS_REVIEW";

/** Test-only fixture evaluator. It cannot be imported by a runtime path or turn real input into trusted evidence. */
function decideSyntheticMatch(
  source: Record<string, string>,
  candidates: readonly Record<string, string>[],
  duplicate: "none" | "exact" | "possible" = "none",
): SyntheticMatch {
  if (duplicate === "exact") return "DUPLICATE";
  if (duplicate === "possible") return "NEEDS_REVIEW";
  if (source.attribution !== "synthetic:source-account") return "SOURCE_UNVERIFIED";
  if (candidates.length === 0) return "UNMATCHED";
  if (candidates.length > 1) return "AMBIGUOUS";
  const candidate = candidates[0]!;
  if (candidate.submission !== source.submission) return "SUBMISSION_UNVERIFIED";
  if (candidate.organization !== source.organization || candidate.provider !== source.provider)
    return "PROVIDER_MISMATCH";
  if (candidate.payer !== source.payer || candidate.program !== source.program)
    return "PAYER_MISMATCH";
  if (candidate.account !== source.account) return "SOURCE_UNVERIFIED";
  if (
    candidate.control !== source.control ||
    candidate.from !== source.from ||
    candidate.to !== source.to
  )
    return "NEEDS_REVIEW";
  return "MATCHED";
}

function evaluateSyntheticObservation(
  observation: ReturnType<typeof observeParsedMedicaidEra>,
  match: SyntheticMatch,
) {
  const review = observation.financialReview;
  return {
    claims: review.claims.map((claim, index) => {
      if (match !== "MATCHED") return { classification: "review_hold" as const, claimIndex: index };
      const sourceClaim = observation.claims[index];
      if (
        claim.status === "payment_reported" &&
        sourceClaim?.statusCode === 1 &&
        sourceClaim.paidCents !== null &&
        sourceClaim.paidCents === sourceClaim.chargeCents &&
        sourceClaim.patientResponsibilityCents === 0 &&
        sourceClaim.adjustments.length === 0 &&
        sourceClaim.serviceLines.every((line) => line.adjustments.length === 0) &&
        review.balance.status === "balanced"
      )
        return { classification: "fully_paid_synthetic_review" as const, claimIndex: index };
      switch (claim.status) {
        case "payer_denied":
          return { classification: "denied" as const, claimIndex: index };
        case "reversal":
          return { classification: "reversed_or_recouped_review" as const, claimIndex: index };
        case "partial_payment":
          return { classification: "partial_payment_review" as const, claimIndex: index };
        case "payment_reported":
          return { classification: "payment_reported_review" as const, claimIndex: index };
        case "zero_payment":
          return { classification: "zero_payment_review" as const, claimIndex: index };
        case "insufficient_data":
          return { classification: "inconsistent_review" as const, claimIndex: index };
      }
    }),
    balance: review.balance.status,
    postingAuthorized: false as const,
  };
}

describe("synthetic Medicaid 835 financial observation", () => {
  it("adapts multiple claims, line and claim adjustments, payment identity, and PLB without attribution or posting", () => {
    const [parsed] = parse(wrap835(CLEAN_BODY, { isa15: "T" }));
    expect(parsed).toBeDefined();
    const observation = observeParsedMedicaidEra(parsed!);

    expect(observation).toMatchObject({
      source: {
        parserPayerProgramContext: "medicaid",
        interchangeControlNumber: "100000001",
        transactionSetControlNumber: "0001",
        traceNumber: "EFT0001",
        paymentCents: 125000,
        payer: { identifier: "99999" },
        payee: { identifier: "1999999999" },
      },
      claims: [
        {
          patientControlNumber: "PCN-0001",
          payerClaimControlNumber: "ICN-A1",
          chargeCents: 100000,
          paidCents: 80000,
          patientResponsibilityCents: 5000,
          serviceLines: [
            {
              procedureCode: "Q5001",
              chargeCents: 60000,
              paidCents: 50000,
              paidUnits: 1,
              adjustments: [{ groupCode: "CO", reasonCode: "45", amountCents: 10000 }],
              references: [{ qualifier: "6R", value: "L1" }],
            },
            {
              procedureCode: "Q5002",
              chargeCents: 40000,
              paidCents: 30000,
              paidUnits: 2,
              adjustments: [
                { groupCode: "PR", reasonCode: "2", amountCents: 5000 },
                { groupCode: "CO", reasonCode: "45", amountCents: 5000 },
              ],
            },
          ],
          remarks: [
            { kind: "MOA", code: "MA01" },
            { kind: "MOA", code: "MA18" },
          ],
        },
        {
          patientControlNumber: "PCN-0002",
          payerClaimControlNumber: "ICN-A2",
          chargeCents: 50000,
          paidCents: 40000,
          serviceLines: [
            {
              revenueCode: "0651",
              paidUnits: 5,
              adjustments: [{ groupCode: "CO", reasonCode: "45", amountCents: 10000 }],
            },
          ],
        },
        {
          patientControlNumber: "PCN-0003",
          payerClaimControlNumber: "ICN-A3",
          chargeCents: 30000,
          paidCents: 0,
          adjustments: [{ groupCode: "CO", reasonCode: "45", amountCents: 30000 }],
          remarks: [{ kind: "MOA", code: "MA130" }],
        },
      ],
      providerAdjustments: [
        { reason: "WO", reference: "REF1", amountCents: 2500 },
        { reason: "L6", reference: "REF2", amountCents: -7500 },
      ],
      attribution: "unverified",
      postingAuthorized: false,
      financialReview: {
        reportedPaymentCents: 125000,
        claimPaymentCents: 120000,
        providerAdjustmentCents: -5000,
        balance: { status: "balanced", differenceCents: 0 },
        financialPostingAuthorized: false,
      },
    });
    expect(observation.financialReview.claims.map(({ status }) => status)).toEqual([
      "partial_payment",
      "partial_payment",
      "payer_denied",
    ]);
  });

  it("keeps transaction sets distinct and never treats parsed control numbers as tenant identity", () => {
    const raw = wrap835Sets([
      ["0001", CLEAN_BODY],
      ["0002", CLEAN_BODY],
    ]);
    const parsed = parse(raw);
    expect(parsed).toHaveLength(2);
    const observations = parsed.map(observeParsedMedicaidEra);
    expect(observations.map((item) => item.source.transactionSetControlNumber)).toEqual([
      "0001",
      "0002",
    ]);
    expect(observations.every((item) => item.attribution === "unverified")).toBe(true);
    expect(observations.every((item) => item.postingAuthorized === false)).toBe(true);
  });

  it("preserves zero-dollar valid denial semantics and leaves identity/source unverified", () => {
    const body = [
      "BPR*H*0.00*C*NON************20260615",
      "TRN*1*TRACE-SYNTH-0*1512345678",
      "N1*PR*SYNTHETIC MEDICAID*XV*99999",
      "N1*PE*SYNTHETIC HOSPICE*XX*1234567893",
      "CLP*PCN-DENY*4*250.00*0.00*0.00*MC*ICN-DENY",
      "CAS*CO*45*250.00",
    ];
    const [parsed] = parse(wrap835(body, { isa15: "T" }));
    const observation = observeParsedMedicaidEra(parsed!);
    expect(observation.source.paymentCents).toBe(0);
    expect(observation.claims[0]).toMatchObject({ chargeCents: 25000, paidCents: 0 });
    expect(observation.financialReview.claims[0]?.status).toBe("payer_denied");
    expect(observation.attribution).toBe("unverified");
    expect(observation.postingAuthorized).toBe(false);
  });

  it("maps documented vendor ERA references into inert retrieval plans and rejects production Stedi mode", () => {
    expect(
      planStediTestEraRetrieval({
        applicationMode: "test",
        transactionId: "12345678-1234-1234-1234-123456789abc",
      }),
    ).toEqual({
      vendor: "stedi",
      mode: "test",
      method: "GET",
      resource: "/change/medicalnetwork/reports/v2/{transactionId}/835",
      transactionId: "12345678-1234-1234-1234-123456789abc",
      network: "disabled",
    });
    expect(
      planStediTestEraRetrieval({
        applicationMode: "production",
        transactionId: "12345678-1234-1234-1234-123456789abc",
      }),
    ).toBeNull();
    expect(
      planClaimMdTestEraRetrieval({
        accountReference: "synthetic:claimmd-account",
        lastEraId: "40",
        returnedEraId: "41",
      }),
    ).toMatchObject({
      vendor: "claimmd",
      firstStep: { service: "eralist", cursor: "40" },
      detailStep: { service: "era835", eraId: "41" },
      network: "disabled",
    });
    expect(
      planClaimMdTestEraRetrieval({
        accountReference: "real-account",
        lastEraId: null,
        returnedEraId: "41",
      }),
    ).toBeNull();
  });

  it("reuses M25 exact and possible duplicate classifications without discarding a possible replay", () => {
    const identity = {
      rawFileDigest: "a".repeat(64),
      interchangeControlNumber: "100000001",
      interchangeSenderCode: "SYNTHMAC",
      interchangeReceiverCode: "SYNTHHOSPICE",
      functionalGroupControlNumber: "77",
      transactionSetControlNumber: "0001",
      paymentTrace: "EFT0001",
      paymentAmount: "1250.00",
      contentDigest: "b".repeat(64),
    };
    expect(classifyClaimMdEraCrossSourceDuplicate(identity, [identity])).toBe("exact_duplicate");
    expect(
      classifyClaimMdEraCrossSourceDuplicate({ ...identity, rawFileDigest: "c".repeat(64) }, [
        identity,
      ]),
    ).toBe("possible_duplicate");
  });

  it("keeps synthetic matching scoped and returns review decisions instead of selecting weak or conflicting matches", () => {
    const source = {
      attribution: "synthetic:source-account",
      organization: "synthetic:org-1",
      provider: "synthetic:provider-1",
      payer: "synthetic:payer-eocco",
      program: "synthetic:program-eocco",
      account: "synthetic:account-1",
      submission: "synthetic:submission-1",
      control: "PCN-0001",
      from: "2026-05-01",
      to: "2026-05-31",
    };
    const candidate = {
      organization: source.organization,
      provider: source.provider,
      payer: source.payer,
      program: source.program,
      account: source.account,
      submission: source.submission,
      control: source.control,
      from: source.from,
      to: source.to,
    };
    expect(decideSyntheticMatch(source, [candidate])).toBe("MATCHED");
    expect(decideSyntheticMatch({ ...source, attribution: "untrusted" }, [candidate])).toBe(
      "SOURCE_UNVERIFIED",
    );
    expect(decideSyntheticMatch(source, [])).toBe("UNMATCHED");
    expect(decideSyntheticMatch(source, [candidate, candidate])).toBe("AMBIGUOUS");
    expect(decideSyntheticMatch(source, [{ ...candidate, organization: "synthetic:org-2" }])).toBe(
      "PROVIDER_MISMATCH",
    );
    expect(decideSyntheticMatch(source, [{ ...candidate, provider: "synthetic:provider-2" }])).toBe(
      "PROVIDER_MISMATCH",
    );
    expect(decideSyntheticMatch(source, [{ ...candidate, payer: "synthetic:payer-ffs" }])).toBe(
      "PAYER_MISMATCH",
    );
    expect(decideSyntheticMatch(source, [{ ...candidate, account: "synthetic:account-2" }])).toBe(
      "SOURCE_UNVERIFIED",
    );
    expect(
      decideSyntheticMatch(source, [{ ...candidate, submission: "synthetic:other-send" }]),
    ).toBe("SUBMISSION_UNVERIFIED");
    expect(decideSyntheticMatch(source, [candidate], "exact")).toBe("DUPLICATE");
    expect(decideSyntheticMatch(source, [candidate], "possible")).toBe("NEEDS_REVIEW");
  });

  it("runs a synthetic matched ERA observation into nonposting reconciliation classifications", () => {
    const [parsed] = parse(wrap835(CLEAN_BODY, { isa15: "T" }));
    const observation = observeParsedMedicaidEra(parsed!);
    const outcome = evaluateSyntheticObservation(observation, "MATCHED");
    expect(outcome).toEqual({
      claims: [
        { classification: "partial_payment_review", claimIndex: 0 },
        { classification: "partial_payment_review", claimIndex: 1 },
        { classification: "denied", claimIndex: 2 },
      ],
      balance: "balanced",
      postingAuthorized: false,
    });
    expect(evaluateSyntheticObservation(observation, "PAYER_MISMATCH").claims).toEqual([
      { classification: "review_hold", claimIndex: 0 },
      { classification: "review_hold", claimIndex: 1 },
      { classification: "review_hold", claimIndex: 2 },
    ]);
  });

  it("recognizes a fully reconciled synthetic claim only as a review outcome", () => {
    const body = [
      "BPR*C*100.00*C*CHK************20260615",
      "TRN*1*TRACE-SYNTH-FULL*1512345678",
      "N1*PR*SYNTHETIC MEDICAID*XV*99999",
      "N1*PE*SYNTHETIC HOSPICE*XX*1234567893",
      "CLP*PCN-FULL*1*100.00*100.00*0.00*MC*ICN-FULL",
      "SVC*NU:0651*100.00*100.00*0651*1",
    ];
    const [parsed] = parse(wrap835(body, { isa15: "T" }));
    const observation = observeParsedMedicaidEra(parsed!);
    expect(evaluateSyntheticObservation(observation, "MATCHED")).toEqual({
      claims: [{ classification: "fully_paid_synthetic_review", claimIndex: 0 }],
      balance: "balanced",
      postingAuthorized: false,
    });
  });
});
