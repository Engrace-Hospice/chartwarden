import { describe, expect, it } from "vitest";
import { createClaimMdProtectedPayloadCipher } from "../../../../bootstrap/claimmd-payload-cipher";
import { projectTenantStageHistory } from "../claimmd-era-store";
import { projectClaimMdEraReviewItem, projectClaimMdEraReviewSummary } from "../claimmd-era-review";

const key = Buffer.alloc(32, 7);
const cipher = createClaimMdProtectedPayloadCipher(
  { activeId: "test-key", byId: new Map([["test-key", key]]) },
  "claimmd-era-stage:v1",
);

function stage(state = "staged", reasonCode: string | null = null) {
  const sourceInboxId = "10000000-0000-4000-8000-000000000001";
  const idempotencyKey = "a".repeat(64);
  const protectedDetailsCipher = cipher
    .seal(
      sourceInboxId,
      idempotencyKey,
      JSON.stringify({
        transactionSet: {
          payer: { name: "Synthetic Payer", id: "payer-id", taxId: "must-not-leak" },
          payee: {
            name: "Synthetic Hospice",
            idQualifier: "XX",
            id: "1999999999",
            taxId: "987654321",
          },
          checkOrEftTraceNumber: "TRACE-SYNTHETIC",
          paymentMethod: "eft",
          totalPaymentAmount: 130,
          productionDate: "2026-10-01",
          providerAdjustments: [{ reason: "WO", reference: "SYNTH-REF", amount: -5 }],
          claims: [
            {
              patientControlNumber: "SYNTH-PCN",
              payerIcn: "SYNTH-ICN",
              statusCode: 1,
              totalCharge: 500,
              totalPayment: 130,
              patientResponsibility: 10,
              patientMemberId: "must-not-leak",
              adjustments: [{ groupCode: "CO", reasonCode: "45", amount: 5 }],
              remarks: [{ kind: "claim", code: "N123", text: "must-not-leak" }],
              serviceLines: [
                {
                  procedureCode: "SYNTH-HCPCS",
                  chargeAmount: 500,
                  paidAmount: 130,
                  references: [{ qualifier: "6R", value: "SYNTH-LINE-1" }, { qualifier: "ZZ", value: "discard-this" }],
                  adjustments: [{ groupCode: "CO", reasonCode: "45", amount: 5 }],
                  remarks: [{ kind: "service", code: "N123", text: "must-not-leak" }],
                },
              ],
            },
          ],
        },
        claimOutcomes: [
          {
            claimId: "synthetic-claim-id",
            pcn: "SYNTH-PCN",
            outcome: "verified",
            billingModule: "M23",
            fileIndex: 0,
            transactionSetControlNumber: "0001",
            patientMemberId: "must-not-leak",
          },
        ],
      }),
    )
    .toString("base64");
  return {
    id: "20000000-0000-4000-8000-000000000002",
    organizationId: "30000000-0000-4000-8000-000000000003",
    providerEntityId: "40000000-0000-4000-8000-000000000004",
    locationId: null,
    sourceInboxId,
    accountReference: "synthetic-account",
    usage: "test" as const,
    original835Digest: "b".repeat(64),
    resolutionId: "50000000-0000-4000-8000-000000000005",
    resolutionVersion: 1,
    idempotencyKey,
    protectedDetailsCipher,
    state,
    safeReasonCode:
      reasonCode ?? (state === "possible_duplicate" ? "POSSIBLE_CROSS_SOURCE_DUPLICATE" : null),
    possibleDuplicateAdviceId: null,
    eraId: "9",
    fileIndex: 0,
    transactionSetControlNumber: "0001",
    createdAt: new Date("2026-10-01T00:00:00Z"),
  };
}

describe("M25 Claim.MD ERA review projection", () => {
  it("projects only durable milestones, sorts actual times, and does not infer stage transitions", () => {
    const stageId = "20000000-0000-4000-8000-000000000002";
    const recoveryRecord = {
      reasonCode: "OPERATOR_REQUEUED",
      outcome: "accepted",
      safeFailureCode: null,
      deliveryAttemptCount: 2,
      createdAt: new Date("2026-10-01T05:00:00.000Z"),
      actorId: "must-not-leak",
    };
    const timeline = projectTenantStageHistory(
      {
        id: stageId,
        organizationId: "30000000-0000-4000-8000-000000000003",
        providerEntityId: "40000000-0000-4000-8000-000000000004",
        locationId: null,
        sourceInboxId: "10000000-0000-4000-8000-000000000001",
        accountReference: "synthetic-account",
        usage: "test",
        eraId: "synthetic-era",
        original835Digest: "a".repeat(64),
        resolutionId: "50000000-0000-4000-8000-000000000005",
        resolutionVersion: 2,
        createdAt: "2026-10-01T03:00:00.000Z",
        state: "held",
        safeReasonCode: "CURRENT_STATE_ONLY",
      },
      {
        discoveredAt: new Date("2026-10-01T00:00:00.000Z"),
        capturedAt: new Date("2026-10-01T01:00:00.000Z"),
        captureState: "captured",
      },
      [
        {
          status: "verified",
          reasonCode: null,
          createdAt: new Date("2026-10-01T02:00:00.000Z"),
        },
      ],
      [
        {
          state: "delivered",
          reasonCode: null,
          attemptCount: 1,
          createdAt: new Date("2026-10-01T04:00:00.000Z"),
          stageIds: [stageId],
        },
      ],
      [recoveryRecord],
    );

    expect(timeline.availability).toBe("available");
    expect(timeline.events.map((event) => event.eventType)).toEqual([
      "era_discovered",
      "era_captured",
      "ownership_verified",
      "m25_stage_created",
      "delivery_delivered",
      "delivery_recovery_accepted",
    ]);
    expect(timeline.events[3]).toMatchObject({ toState: null, reasonCode: null });
    expect(JSON.stringify(timeline)).not.toContain("must-not-leak");
    expect(JSON.stringify(timeline)).not.toContain("synthetic-account");
  });

  it("reports partial history rather than manufacturing missing ingestion or ownership events", () => {
    const timeline = projectTenantStageHistory(
      {
        id: "20000000-0000-4000-8000-000000000002",
        organizationId: "30000000-0000-4000-8000-000000000003",
        providerEntityId: "40000000-0000-4000-8000-000000000004",
        locationId: null,
        sourceInboxId: "10000000-0000-4000-8000-000000000001",
        accountReference: "synthetic-account",
        usage: "test",
        eraId: "synthetic-era",
        original835Digest: "a".repeat(64),
        resolutionId: null,
        resolutionVersion: null,
        createdAt: "2026-10-01T03:00:00.000Z",
        state: "held",
        safeReasonCode: "UNSUPPORTED_STATE",
      },
      undefined,
      [],
      [],
      [],
    );
    expect(timeline.availability).toBe("partial");
    expect(timeline.events).toHaveLength(1);
    expect(timeline.events[0]).toMatchObject({ eventType: "m25_stage_created", toState: null });
  });

  it("returns authorized reconciliation evidence without TIN, member identifiers, or free text", () => {
    const item = projectClaimMdEraReviewItem(stage(), cipher);
    expect(item).toMatchObject({
      detailsAvailable: true,
      reconciliationEligible: true,
      payer: { name: "Synthetic Payer", identifier: "payer-id" },
      payee: { name: "Synthetic Hospice", npi: "1999999999" },
      payment: { trace: "TRACE-SYNTHETIC", amount: 130 },
      claims: [
        {
          patientControlNumber: "SYNTH-PCN",
          payerIcn: "SYNTH-ICN",
          serviceLines: [{ procedureCode: "SYNTH-HCPCS" }],
        },
      ],
      providerAdjustments: [{ reason: "WO", amount: -5 }],
      claimOutcomes: [
        {
          outcome: "verified",
          module: "M23",
          patientControlNumber: "SYNTH-PCN",
          claimId: "synthetic-claim-id",
        },
      ],
    });
    const serialized = JSON.stringify(item);
    expect(serialized).not.toContain("987654321");
    expect(serialized).not.toContain("must-not-leak");
  });

  it("retains the namespaced payer line reference but does not invent original line identity", () => {
    const item = projectClaimMdEraReviewItem(stage() as never, cipher);
    expect(item.claims[0]?.serviceLines[0]?.payerLineReference).toBe("SYNTH-LINE-1");
    expect(JSON.stringify(item)).not.toContain("discard-this");
  });

  it("keeps possible duplicates held and ineligible for reconciliation", () => {
    const item = projectClaimMdEraReviewItem(stage("possible_duplicate"), cipher);
    expect(item.possibleDuplicate).toBe(true);
    expect(item.reconciliationEligible).toBe(false);
    expect(item.holdReason).toBe("POSSIBLE_CROSS_SOURCE_DUPLICATE");
  });

  it("distinguishes an exact duplicate from a possible duplicate without making it eligible", () => {
    const item = projectClaimMdEraReviewItem(stage("held", "EXACT_DUPLICATE_FROM_M25"), cipher);
    expect(item.duplicateClassification).toBe("exact");
    expect(item.possibleDuplicate).toBe(false);
    expect(item.reconciliationEligible).toBe(false);
  });

  it("returns only an aggregate list summary and reserves claim details for the selected record", () => {
    const summary = projectClaimMdEraReviewSummary(stage(), cipher);
    expect(summary).toMatchObject({
      claimCount: 1,
      identityExceptionCount: 0,
      reconciliationEligible: true,
    });
    expect(summary).not.toHaveProperty("claims");
    expect(summary).not.toHaveProperty("claimOutcomes");
    expect(summary).not.toHaveProperty("payment.trace");
  });
});
