import { createClaimMdProtectedPayloadCipher } from "../../../../bootstrap/claimmd-payload-cipher";
import { describe, expect, it } from "vitest";
import { projectClaimMdEraReviewItem } from "../claimmd-era-review";

const key = Buffer.alloc(32, 7);
const cipher = createClaimMdProtectedPayloadCipher({ activeId: "test-key", byId: new Map([["test-key", key]]) }, "claimmd-era-stage:v1");

function stage(state = "staged") {
  const sourceInboxId = "10000000-0000-4000-8000-000000000001";
  const idempotencyKey = "a".repeat(64);
  const protectedDetailsCipher = cipher.seal(sourceInboxId, idempotencyKey, JSON.stringify({
    transactionSet: {
      payer: { name: "Synthetic Payer", id: "payer-id", taxId: "must-not-leak" },
      payee: { name: "Synthetic Hospice", idQualifier: "XX", id: "1999999999", taxId: "987654321" },
      checkOrEftTraceNumber: "TRACE-SYNTHETIC", paymentMethod: "eft", totalPaymentAmount: 130,
      productionDate: "2026-10-01", providerAdjustments: [{ reason: "WO", reference: "SYNTH-REF", amount: -5 }],
      claims: [{ patientControlNumber: "SYNTH-PCN", payerIcn: "SYNTH-ICN", statusCode: 1,
        totalCharge: 500, totalPayment: 130, patientResponsibility: 10, patientMemberId: "must-not-leak",
        adjustments: [{ groupCode: "CO", reasonCode: "45", amount: 5 }],
        remarks: [{ kind: "claim", code: "N123", text: "must-not-leak" }],
        serviceLines: [{ procedureCode: "SYNTH-HCPCS", chargeAmount: 500, paidAmount: 130,
          adjustments: [{ groupCode: "CO", reasonCode: "45", amount: 5 }],
          remarks: [{ kind: "service", code: "N123", text: "must-not-leak" }] }],
      }],
    },
    claimOutcomes: [{ claimId: "synthetic-claim-id", outcome: "matched", module: "M23", fileIndex: 0,
      transactionSetControlNumber: "0001", patientMemberId: "must-not-leak" }],
  })).toString("base64");
  return {
    id: "20000000-0000-4000-8000-000000000002", organizationId: "30000000-0000-4000-8000-000000000003",
    providerEntityId: "40000000-0000-4000-8000-000000000004", locationId: null, sourceInboxId,
    idempotencyKey, protectedDetailsCipher, state, safeReasonCode: state === "possible_duplicate" ? "POSSIBLE_CROSS_SOURCE_DUPLICATE" : null,
    possibleDuplicateAdviceId: null, eraId: "9", fileIndex: 0, createdAt: new Date("2026-10-01T00:00:00Z"),
  };
}

describe("M25 Claim.MD ERA review projection", () => {
  it("returns authorized reconciliation evidence without TIN, member identifiers, or free text", () => {
    const item = projectClaimMdEraReviewItem(stage(), cipher);
    expect(item).toMatchObject({ detailsAvailable: true, reconciliationEligible: true,
      payer: { name: "Synthetic Payer", identifier: "payer-id" },
      payee: { name: "Synthetic Hospice", npi: "1999999999" },
      payment: { trace: "TRACE-SYNTHETIC", amount: 130 },
      claims: [{ patientControlNumber: "SYNTH-PCN", payerIcn: "SYNTH-ICN", serviceLines: [{ procedureCode: "SYNTH-HCPCS" }] }],
      providerAdjustments: [{ reason: "WO", amount: -5 }], claimOutcomes: [{ outcome: "matched", module: "M23" }] });
    const serialized = JSON.stringify(item);
    expect(serialized).not.toContain("987654321");
    expect(serialized).not.toContain("must-not-leak");
  });

  it("keeps possible duplicates held and ineligible for reconciliation", () => {
    const item = projectClaimMdEraReviewItem(stage("possible_duplicate"), cipher);
    expect(item.possibleDuplicate).toBe(true);
    expect(item.reconciliationEligible).toBe(false);
    expect(item.holdReason).toBe("POSSIBLE_CROSS_SOURCE_DUPLICATE");
  });
});
