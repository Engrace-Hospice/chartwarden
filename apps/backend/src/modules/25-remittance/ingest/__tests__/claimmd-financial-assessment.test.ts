import type { ParsedClaim835, X12835WorkerClient } from "@chartwarden/x12-835-client";
import { describe, expect, it } from "vitest";
import {
  PAYEE_UNCHECKED,
  buildDrizzleM25IngestService,
  getM25TransactionPostingPort,
} from "../service-drizzle";

const base: ParsedClaim835 = {
  patientControlNumber: "SYNTHETIC-PCN-PARTIAL",
  payerIcn: "SYNTHETIC-ICN-PARTIAL",
  statusCode: 1,
  totalCharge: 100,
  totalPayment: 70,
  patientResponsibility: 0,
  adjustments: [{ groupCode: "OA", reasonCode: "45", amount: 30 }],
  remarks: [],
  serviceLines: [],
};

function assessment(category: string | null = "informational") {
  const service = buildDrizzleM25IngestService({} as never, {
    client: {} as X12835WorkerClient,
    payeeNpi: PAYEE_UNCHECKED,
    terminology: {
      async lookup() {
        return category ? { category, plainLanguage: "Synthetic code description" } : null;
      },
    },
  });
  return getM25TransactionPostingPort(service).assessClaimMdFinancialFacts;
}

describe("M25 controlled Claim.MD financial assessment", () => {
  it("supports only a balanced claim-level OA residual as flagged unresolved", async () => {
    await expect(assessment()(base)).resolves.toMatchObject({
      status: "partial_paid",
      chargeCents: 10_000,
      paidCents: 7_000,
      patientResponsibilityCents: 0,
      unresolvedCents: 3_000,
      adjustments: [
        {
          groupCode: "OA",
          reasonCode: "45",
          amountCents: 3_000,
          classification: "other_adjustment_unresolved",
          responsibility: "other_unallocated",
          accountingDisposition: "unresolved_review",
          policyVersion: null,
          m25Action: "flagged_review",
        },
      ],
    });
  });

  it("classifies a balanced CO amount as provider-reported but blocks write-off without scoped policy", async () => {
    const result = await assessment("reduction")({
      ...base,
      adjustments: [{ groupCode: "CO", reasonCode: "45", amount: 30 }],
    });
    expect(result).toMatchObject({
      status: "unsupported",
      blocker: "CONTRACTUAL_ADJUSTMENT_POLICY_UNAVAILABLE",
      unresolvedCents: 3_000,
      adjustments: [
        {
          groupCode: "CO",
          reasonCode: "45",
          amountCents: 3_000,
          responsibility: "provider_reported",
          classification: "contractual_obligation_reported",
          accountingDisposition: "policy_required",
          policyVersion: null,
          m25Action: "not_authorized",
        },
      ],
    });
  });

  it("preserves PR reporting without creating patient billing authority", async () => {
    const result = await assessment("reduction")({
      ...base,
      patientResponsibility: 30,
      adjustments: [{ groupCode: "PR", reasonCode: "1", amount: 30 }],
    });
    expect(result).toMatchObject({
      status: "unsupported",
      blocker: "PATIENT_RESPONSIBILITY_POLICY_UNAVAILABLE",
      patientResponsibilityCents: 3_000,
      adjustments: [
        {
          groupCode: "PR",
          amountCents: 3_000,
          responsibility: "patient_reported",
          accountingDisposition: "policy_required",
          m25Action: "not_authorized",
        },
      ],
    });
  });

  it("blocks a CLP05 and CAS PR mismatch without summing the two values", async () => {
    await expect(
      assessment("reduction")({
        ...base,
        patientResponsibility: 29,
        adjustments: [{ groupCode: "PR", reasonCode: "1", amount: 30 }],
      }),
    ).resolves.toMatchObject({
      status: "unsupported",
      blocker: "UNSUPPORTED_FINANCIAL_FACTS",
      patientResponsibilityCents: 2_900,
      adjustments: [
        {
          groupCode: "PR",
          amountCents: 3_000,
          responsibility: "patient_reported",
          m25Action: "not_authorized",
        },
      ],
    });
  });

  it("does not classify a CO adjustment whose CARC is absent from the terminology catalog", async () => {
    await expect(
      assessment(null)({
        ...base,
        adjustments: [{ groupCode: "CO", reasonCode: "99999", amount: 30 }],
      }),
    ).resolves.toMatchObject({
      status: "unsupported",
      blocker: "ADJUSTMENT_CLASSIFICATION_UNAVAILABLE",
      adjustments: [
        {
          groupCode: "CO",
          reasonCode: "99999",
          classification: "contractual_obligation_reported",
          m25Action: "not_authorized",
        },
      ],
    });
  });

  it("recognizes PI as payer-reported and does not write it off", async () => {
    await expect(
      assessment("reduction")({
        ...base,
        adjustments: [{ groupCode: "PI", reasonCode: "45", amount: 30 }],
      }),
    ).resolves.toMatchObject({
      status: "unsupported",
      blocker: "PAYER_REDUCTION_POLICY_UNAVAILABLE",
      adjustments: [
        {
          groupCode: "PI",
          responsibility: "payer_initiated_reported",
          classification: "payer_initiated_reduction_reported",
          m25Action: "not_authorized",
        },
      ],
    });
  });

  const unsupportedCases: [string, Partial<ParsedClaim835>][] = [
    [
      "mismatched CAS amount",
      { adjustments: [{ groupCode: "OA", reasonCode: "45", amount: 29.99 }] },
    ],
    [
      "patient responsibility",
      { patientResponsibility: 5, adjustments: [{ groupCode: "PR", reasonCode: "1", amount: 5 }] },
    ],
    ["provider reference", { references: [{ qualifier: "6R", value: "line-1" }] }],
    [
      "service-line adjudication",
      {
        serviceLines: [
          { procedureCode: "SYN", chargeAmount: 100, paidAmount: 70, adjustments: [], remarks: [] },
        ],
      },
    ],
    [
      "multiple CAS entries",
      {
        adjustments: [
          { groupCode: "OA", reasonCode: "45", amount: 20 },
          { groupCode: "OA", reasonCode: "23", amount: 10 },
        ],
      },
    ],
  ];
  it.each(unsupportedCases)("blocks %s", async (_name, change) => {
    const result = await assessment()({ ...base, ...change });
    expect(result.status).toBe("unsupported");
  });

  it.each(["denial", "recoupment", "unmapped", "not-mapped"])(
    "blocks CARC classification %s",
    async (category) => {
      const lookupCategory = category === "not-mapped" ? null : category;
      const result = await assessment(lookupCategory)(base);
      expect(result).toMatchObject({
        status: "unsupported",
        blocker: "ADJUSTMENT_CLASSIFICATION_UNAVAILABLE",
      });
    },
  );
});
