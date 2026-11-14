import { describe, expect, it, vi } from "vitest";
import { createAuthoritativeMedicareNoticeSourceLoader } from "./medicare-notice-source-loader";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "11111111-1111-4111-8111-111111111112";
const NOTICE = "22222222-2222-4222-8222-222222222222";
const SUBMISSION = "33333333-3333-4333-8333-333333333333";
const PROVIDER = "44444444-4444-4444-8444-444444444444";
const PATIENT = "55555555-5555-4555-8555-555555555555";
const ADMISSION = "66666666-6666-4666-8666-666666666666";
const ELECTION = "77777777-7777-4777-8777-777777777777";
const TRANSFER = "88888888-8888-4888-8888-888888888888";

function harness(overrides: { mbi?: string | null; triggerKind?: "revocation" | "transfer_out" | "discharge" } = {}) {
  const disclosure = vi.fn();
  const clinical = {
    organizationId: ORG,
    admissionId: ADMISSION,
    patientId: PATIENT,
    providerEntityId: PROVIDER,
    electionPeriodId: ELECTION,
    electionStatementId: "99999999-9999-4999-8999-999999999999",
    relatedSourceId: ELECTION,
    admissionDate: "2026-01-01",
    statementFromDate: "2026-01-01",
    terminationDate: null,
    principalDiagnosis: "J44.9",
    attendingPhysicianId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    certifyingPhysicianId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    sourceVersions: { admission: 1, election: 2 },
  };
  const noe = {
    id: NOTICE, organizationId: ORG, providerEntityId: PROVIDER, patientId: PATIENT,
    admissionId: ADMISSION, electionPeriodId: ELECTION, electionEffectiveDate: "2026-01-01",
    noeControlNumber: "NOE-001", state: "ready", version: 1,
  };
  const notr = {
    ...noe, triggerKind: overrides.triggerKind ?? "revocation", effectiveEndDate: "2026-02-01",
    notrControlNumber: "NOTR-001", revocationEventId: TRANSFER, transferEventId: null,
    dischargeEventId: null,
  };
  const transfer = {
    ...noe, transferEventId: TRANSFER, statementFromDate: "2026-01-01",
    admissionDate: "2026-01-01", action: "original", controlNumber: "TR-001", tob: "81C",
    supersedesNoticeId: null, originalTransferDate: null, cancelReason: null,
    priorBillingConfirmedAt: new Date("2026-01-02T00:00:00Z"),
    priorHospiceThroughDate: "2025-12-31", priorHospicePatientStatus: "30",
    priorHospiceCcn: "123456", benefitPeriodStartDate: "2025-12-01",
  };
  const attempt = {
    id: SUBMISSION, organizationId: ORG, providerEntityId: PROVIDER, kind: "noe",
    noeId: NOTICE, notrId: null, transferNoticeId: null, outcome: "queued", dispatchState: "pending",
  };
  const relatedTransfers = new Map<string, typeof transfer>();
  const deps = {
    persistence: {
      noeById: async (org: string) => org === ORG ? noe : null,
      notrById: async (org: string) => org === ORG ? notr : null,
      transferById: async (org: string, id: string) =>
        org === ORG ? (id === NOTICE ? transfer : relatedTransfers.get(id) ?? null) : null,
      submissionById: async (org: string) => org === ORG ? attempt : null,
      finalClaimFiledForAdmission: async () => false,
    },
    clinical: {
      loadNoe: async () => clinical,
      loadNotr: async () => ({ ...clinical, terminationDate: "2026-02-01" }),
      loadTransferOrCancellation: async () => ({ ...clinical, relatedSourceId: TRANSFER }),
    },
    coverages: {
      activeCoverageOfKind: async () => ({
        id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", patientId: PATIENT, payerId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        coverageKind: "medicare_ffs", effectiveFrom: "2025-01-01", effectiveTo: null,
      }),
    },
    mbiUnlock: () => ({
      unlockForEligibility: async (input: { disclosure: unknown }) => {
        disclosure(input.disclosure);
        return overrides.mbi === null ? null : {
          mbi: overrides.mbi ?? "1EG4TE5MK73", patientPayerId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          firstName: "Jane", lastName: "Testpatient", dateOfBirth: "1940-01-01",
        };
      },
    }),
    patients: { findById: async () => ({ administrativeSex: "F" }) },
    addresses: { primaryAddressAt: async () => ({ line1: "123 Test St", city: "Testville", state: "OR", postalCode: "00000" }) },
    physicians: { resolvePhysician: async (_org: string, id: string) => ({
      status: "active", canonical: { identifierValue: "1234567893", firstName: "Test", lastName: id.endsWith("a") ? "Attending" : "Certifier" },
    }) },
    provider: { ccnFor: async () => "654321" },
    route: { resolve: async () => ({
      jurisdiction: "noridian_jf", vendor: "claimmd", accountReference: `tenant:${ORG}`,
      usage: "test", payerId: "00123", canonicalPayerId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      routeFingerprint: "route-fingerprint", transactionSupportVerified: false,
    }) },
    partiesFor: () => ({ partiesFor: async () => ({
      submitter: { name: "Synthetic Hospice", id: "SUBMITTER", contactName: "Billing", contactPhone: "5550100" },
      receiver: { name: "ClaimMD", id: "RECEIVER", applicationCode: "RECEIVER" },
      billingProvider: { organizationName: "Synthetic Hospice", npi: "1234567893", taxId: "900123456", address: { line1: "123 Test St", city: "Testville", state: "OR", postalCode: "00000" } },
      payer: { name: "Medicare", payerId: "00123" },
    }) }),
  };
  return { loader: createAuthoritativeMedicareNoticeSourceLoader(deps as never), disclosure, attempt, transfer, relatedTransfers };
}

describe("authoritative Medicare notice source loader", () => {
  it("maps M5/M6/M40/M23 facts into NOE input and audits the transient MBI read", async () => {
    const { loader, disclosure } = harness();
    const result = await loader.loadNoe({ organizationId: ORG, noticeId: NOTICE, submissionId: SUBMISSION });
    expect(result.input.subscriber.mbi).toBe("1EG4TE5MK73");
    expect(result.input.payer.payerId).toBe("00123");
    expect(result.input.otherPhysician?.lastName).toBe("Certifier");
    expect(result.identity.vendor).toBe("claimmd");
    expect(disclosure).toHaveBeenCalledWith({ purpose: "medicare_notice_render", subjectId: SUBMISSION });
  });

  it("returns a PHI-safe typed hold when mandatory MBI is missing", async () => {
    const { loader } = harness({ mbi: null });
    await expect(loader.loadNoe({ organizationId: ORG, noticeId: NOTICE, submissionId: SUBMISSION }))
      .rejects.toMatchObject({ code: "NOTICE_FACTS_INCOMPLETE", field: "subscriber.mbi" });
  });

  it("does not expose another organization's source records", async () => {
    const { loader } = harness();
    await expect(loader.loadNoe({ organizationId: OTHER_ORG, noticeId: NOTICE, submissionId: SUBMISSION }))
      .rejects.toMatchObject({ code: "NOTICE_SOURCE_NOT_FOUND", field: "noe" });
  });

  it("rejects an ordinary transfer as a NOTR before clinical rendering", async () => {
    const { loader, attempt } = harness({ triggerKind: "transfer_out" });
    Object.assign(attempt, { kind: "notr", noeId: null, notrId: NOTICE });
    await expect(loader.loadNotr({ organizationId: ORG, noticeId: NOTICE, submissionId: SUBMISSION }))
      .rejects.toMatchObject({ code: "NOTICE_SOURCE_INVALID", field: "notr.triggerKind" });
  });

  it("classifies 8xD through the cancellation loader, never as an ordinary transfer", async () => {
    const { loader, attempt, transfer, relatedTransfers } = harness();
    Object.assign(attempt, { kind: "transfer_notice", noeId: null, transferNoticeId: NOTICE });
    Object.assign(transfer, {
      action: "void", tob: "81D", cancelReason: "original transfer entered in error",
      supersedesNoticeId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      priorBillingConfirmedAt: null, priorHospiceThroughDate: null, priorHospicePatientStatus: null,
    });
    const original = { ...transfer, id: transfer.supersedesNoticeId, action: "original", state: "ack_accepted" };
    relatedTransfers.set(original.id!, original);
    await expect(loader.loadTransfer({ organizationId: ORG, noticeId: NOTICE, submissionId: SUBMISSION }))
      .rejects.toMatchObject({ code: "NOTICE_SOURCE_INVALID", field: "transferNotice.action" });
    const result = await loader.loadCancellation({ organizationId: ORG, noticeId: NOTICE, submissionId: SUBMISSION });
    expect(result.identity.kind).toBe("cancellation_notice");
    expect(result.input.document.frequencyCode).toBe("D");
    expect(result.input.document.tob).toBe("81D");
  });
});
