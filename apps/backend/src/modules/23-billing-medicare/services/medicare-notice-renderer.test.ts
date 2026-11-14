import { describe, expect, it } from "vitest";
import type { Notice837iInput, TransferNotice837iInput } from "@chartwarden/x12-837-client";
import {
  createMedicareNoticeRenderer,
  type MedicareNoticeRenderIdentity,
  type MedicareNoticeRenderReservation,
} from "./medicare-notice-renderer";

const suffix = (kind: MedicareNoticeRenderIdentity["kind"]): string =>
  kind === "noe" ? "1" : kind === "notr" ? "2" : kind === "transfer_notice" ? "3" : "4";
const identity = (kind: MedicareNoticeRenderIdentity["kind"]): MedicareNoticeRenderIdentity => ({
  organizationId: "11111111-1111-4111-8111-111111111111",
  noticeId: `22222222-2222-4222-8222-22222222222${suffix(kind)}`,
  submissionId: `33333333-3333-4333-8333-33333333333${suffix(kind)}`,
  kind,
  relatedSourceId: "44444444-4444-4444-8444-444444444444",
  sourceVersion: "source-v1",
  routeFingerprint: "route-v1",
  providerEntityId: "55555555-5555-4555-8555-555555555555",
  jurisdiction: "ngs_j6",
  vendor: "direct_mac",
  accountReference: "synthetic-account",
  usage: "test",
  mapperVersion: "m23-notice-mapper-v1",
  controlNumber: "N-123",
});

const parties = {
  submitter: { name: "SYNTHETIC HOSPICE", id: "SYNTH1", contactName: "BILLING", contactPhone: "5555550100" },
  receiver: { name: "SYNTHETIC MAC", id: "MAC1" },
  billingProvider: {
    organizationName: "SYNTHETIC HOSPICE", npi: "1234567893", taxId: "123456789",
    address: { line1: "1 TEST WAY", city: "TESTVILLE", state: "OR", postalCode: "97000" },
  },
  subscriber: {
    lastName: "TEST", firstName: "PATIENT", mbi: "1EG4TE5MK73", address: { line1: "2 TEST WAY", city: "TESTVILLE", state: "OR", postalCode: "97000" },
    birthDate: "1940-01-01", sex: "F" as const,
  },
  payer: { name: "MEDICARE", payerId: "12345" },
};

const envelope = {
  senderId: "SYNTH1", receiverId: "MAC1", applicationReceiverCode: "MAC1",
  interchangeControlNumber: 1, usage: "T" as const, createdAt: new Date("2026-01-01T00:00:00Z"),
};

function identityStore() {
  const rows = new Map<string, MedicareNoticeRenderReservation>();
  return {
    rows,
    reserve: async ({ identity: source, fingerprint }: { identity: MedicareNoticeRenderIdentity; fingerprint: string }) => {
      const old = rows.get(source.submissionId);
      if (old) return old;
      const row = { identity: source, fingerprint, interchangeNumber: 7, renderedAt: new Date("2026-01-02T00:00:00Z") };
      rows.set(source.submissionId, row);
      return row;
    },
  };
}

describe("internal Medicare notice renderer", () => {
  it("recovers a finalized artifact before loading facts or invoking a builder", async () => {
    const original = "ISA*EXACT~\rGS*EXACT~";
    let sourceCalls = 0;
    let persistCalls = 0;
    const expected = {
      organizationId: identity("noe").organizationId,
      noticeId: identity("noe").noticeId,
      submissionId: identity("noe").submissionId,
      kind: "noe" as const,
      transactionSet: "837" as const,
      usage: "test" as const,
      sourceFingerprint: "fixed-fingerprint",
      routeFingerprint: "route-v1",
      interchangeControlNumber: "000000007",
      renderedAt: new Date("2026-01-02T00:00:00Z"),
      x12: original,
    };
    const renderer = createMedicareNoticeRenderer({
      fingerprintKey: "synthetic-test-key-0123456789abcdef0123456789abcdef",
      identities: identityStore(),
      artifacts: {
        recover: async () => expected,
        persist: async () => { persistCalls += 1; return expected; },
      },
      sources: {
        loadNoe: async () => { sourceCalls += 1; throw new Error("must not load current facts"); },
        loadNotr: async () => { throw new Error("not used"); },
        loadTransfer: async () => { throw new Error("not used"); },
        loadCancellation: async () => { throw new Error("not used"); },
      },
    });
    expect((await renderer.renderNoe({ organizationId: expected.organizationId, noticeId: expected.noticeId, submissionId: expected.submissionId })).x12).toBe(original);
    expect(sourceCalls).toBe(0);
    expect(persistCalls).toBe(0);
  });

  it("renders NOE and NOTR with the internal builder and stable envelope identity", async () => {
    const store = identityStore();
    const noeInput: Notice837iInput = {
      ...parties, envelope,
      notice: { kind: "NOE", controlNumber: "N-123", admissionDate: "2026-01-01" },
      principalDiagnosis: "J44.9", attendingPhysician: { firstName: "TEST", lastName: "DOCTOR", npi: "1234567893" },
    };
    const notrInput: Notice837iInput = {
      ...noeInput,
      notice: { kind: "NOTR", controlNumber: "N-123", admissionDate: "2026-01-01", terminationDate: "2026-02-01" },
    };
    let selected: Notice837iInput = noeInput;
    const renderer = createMedicareNoticeRenderer({
      fingerprintKey: "synthetic-test-key-0123456789abcdef0123456789abcdef",
      identities: store,
      sources: {
        loadNoe: async (req) => ({ ready: true, identity: { ...identity("noe"), ...req }, input: selected }),
        loadNotr: async (req) => ({ ready: true, identity: { ...identity("notr"), ...req }, input: selected }),
        loadTransfer: async (req) => ({ ready: true, identity: { ...identity("transfer_notice"), ...req }, input: transferInput }),
        loadCancellation: async () => { throw new Error("not used"); },
      },
    });
    const request = { organizationId: identity("noe").organizationId, noticeId: identity("noe").noticeId, submissionId: identity("noe").submissionId };
    const first = await renderer.renderNoe(request);
    expect(first.x12).toContain("ISA*");
    expect(first.x12).toContain("ST*837*0007*");
    expect(first.interchangeControlNumber).toBe("000000007");
    expect((await renderer.renderNoe(request)).x12).toBe(first.x12);

    selected = notrInput;
    const notrIdentity = { ...request, noticeId: identity("notr").noticeId, submissionId: identity("notr").submissionId };
    expect((await renderer.renderNotr(notrIdentity)).x12).toContain("81:A:B");
  });

  const transferInput: TransferNotice837iInput = {
    ...parties, envelope,
    document: {
      controlNumber: "T-123", action: "original", tob: "81C", frequencyCode: "C",
      statementFromDate: "2026-01-01", admissionDate: "2026-01-01", conditionCodes: [], occurrenceCodes: [],
    },
    principalDiagnosis: "J44.9",
    attendingPhysician: { firstName: "TEST", lastName: "DOCTOR", npi: "1234567893" },
    otherPhysician: null,
  };

  it("renders 8xC and 8xD only via the existing transfer builder", async () => {
    const store = identityStore();
    let input = transferInput;
    let sourceVersion = "source-v1";
    const renderer = createMedicareNoticeRenderer({
      fingerprintKey: "synthetic-test-key-0123456789abcdef0123456789abcdef",
      identities: store,
      sources: {
        loadNoe: async () => { throw new Error("not used"); },
        loadNotr: async () => { throw new Error("not used"); },
        loadTransfer: async (req) => ({ ready: true, identity: { ...identity("transfer_notice"), ...req, sourceVersion }, input }),
        loadCancellation: async () => { throw new Error("not used"); },
      },
    });
    const request = { organizationId: identity("transfer_notice").organizationId, noticeId: identity("transfer_notice").noticeId, submissionId: identity("transfer_notice").submissionId };
    expect((await renderer.renderTransfer(request)).x12).toContain("81:A:C");
    input = {
      ...transferInput,
      document: { ...transferInput.document, action: "void", tob: "81D", frequencyCode: "D" },
    };
    sourceVersion = "source-v2";
    // A changed source under the same attempt must hold, not silently regenerate a new payload.
    await expect(renderer.renderTransfer(request)).rejects.toMatchObject({ code: "NOTICE_IDENTITY_CHANGED" });
    const voidRenderer = createMedicareNoticeRenderer({
      fingerprintKey: "synthetic-test-key-0123456789abcdef0123456789abcdef",
      identities: identityStore(),
      sources: {
        loadNoe: async () => { throw new Error("not used"); },
        loadNotr: async () => { throw new Error("not used"); },
        loadTransfer: async () => { throw new Error("8xD is not a transfer"); },
        loadCancellation: async (req) => ({ ready: true, identity: { ...identity("cancellation_notice"), ...req, sourceVersion: "source-v2" }, input }),
      },
    });
    const cancellationRequest = {
      organizationId: identity("cancellation_notice").organizationId,
      noticeId: identity("cancellation_notice").noticeId,
      submissionId: identity("cancellation_notice").submissionId,
    };
    expect((await voidRenderer.renderCancellation(cancellationRequest)).x12).toContain("81:A:D");
  });
});
