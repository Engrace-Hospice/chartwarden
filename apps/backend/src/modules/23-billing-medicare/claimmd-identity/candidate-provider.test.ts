import { describe, expect, it, vi } from "vitest";
import { candidateAttemptKeyIsValid, createClaimMdCandidateProvider, isVerifiedM23SubmissionEvidence, isVerifiedM41SubmissionEvidence, isVerifiedReceiptObservation } from "./candidate-provider";
import type { ClaimMdIdentityEvent } from "./resolve";

const org = "10000000-0000-4000-8000-000000000001";
const provider = "20000000-0000-4000-8000-000000000001";
const claim = "30000000-0000-4000-8000-000000000001";
const submission = "40000000-0000-4000-8000-000000000001";
const location = "50000000-0000-4000-8000-000000000001";
const attempt = { organizationId: org, providerEntityId: provider, usage: "test", controlNumber: "SYNTH-PCN-1", kind: "claim", status: "sent" };

describe("BIL-1.2.2B M23/M41 candidate evidence verification", () => {
  it("accepts only the exact M23 claim submission, provider, PCN and attempt index", () => {
    const input = { organizationId: org, providerEntityId: provider, claimId: claim, submissionId: submission,
      attemptKey: `${submission}:2`, pcn: "SYNTH-PCN-1", source: { id: submission, organizationId: org,
        providerEntityId: provider, claimId: claim, kind: "claim_837i", controlNumber: "SYNTH-PCN-1", attemptIndex: 2 },
      transportAttempt: attempt };
    expect(isVerifiedM23SubmissionEvidence(input)).toBe(true);
    expect(isVerifiedM23SubmissionEvidence({ ...input, source: { ...input.source, organizationId: "60000000-0000-4000-8000-000000000001" } })).toBe(false);
    expect(isVerifiedM23SubmissionEvidence({ ...input, source: { ...input.source, attemptIndex: 1 } })).toBe(false);
    expect(isVerifiedM23SubmissionEvidence({ ...input, source: { ...input.source, kind: "noe" } })).toBe(false);
    expect(isVerifiedM23SubmissionEvidence({ ...input, transportAttempt: { ...attempt, status: "released" } })).toBe(false);
  });

  it("accepts M41's exact historical submission row and its provider/location/payer route", () => {
    const input = { organizationId: org, providerEntityId: provider, locationId: location, claimId: claim,
      submissionId: submission, attemptKey: `${submission}:3`, pcn: "SYNTH-PCN-2", payerId: "SYNTH-PAYER-A",
      source: { id: submission, organizationId: org, providerEntityId: provider, locationId: location,
        claimId: claim, controlNumber: "SYNTH-PCN-2", payerId: "SYNTH-PAYER-A", vendor: "claimmd" },
      transportAttempt: { ...attempt, controlNumber: "SYNTH-PCN-2" } };
    expect(isVerifiedM41SubmissionEvidence(input)).toBe(true);
    expect(isVerifiedM41SubmissionEvidence({ ...input, source: { ...input.source, providerEntityId: org } })).toBe(false);
    expect(isVerifiedM41SubmissionEvidence({ ...input, source: { ...input.source, payerId: "SYNTH-PAYER-B" } })).toBe(false);
    expect(isVerifiedM41SubmissionEvidence({ ...input, source: { ...input.source, locationId: null } })).toBe(false);
    expect(isVerifiedM41SubmissionEvidence({ ...input, source: { ...input.source, vendor: "stedi" } })).toBe(false);
    // Current provider profile is deliberately not an input to this historical evidence verifier.
  });

  it("keeps vendor receipt fields in separate namespaces and validates attempt-key shape", () => {
    expect(candidateAttemptKeyIsValid("M23", submission, `${submission}:0`, 0)).toBe(true);
    expect(candidateAttemptKeyIsValid("M23", submission, `${submission}:1`, 0)).toBe(false);
    expect(candidateAttemptKeyIsValid("M41", submission, `${submission}:4`, null)).toBe(true);
    expect(candidateAttemptKeyIsValid("M41", submission, `${claim}:4`, null)).toBe(false);
    expect(isVerifiedReceiptObservation("fileid", "file")).toBe(true);
    expect(isVerifiedReceiptObservation("inboundid", "file")).toBe(true);
    expect(isVerifiedReceiptObservation("claimid", "claim")).toBe(true);
    expect(isVerifiedReceiptObservation("claimid", "remote_claim")).toBe(false);
    expect(isVerifiedReceiptObservation("responseid", "message")).toBe(false);
    expect(isVerifiedReceiptObservation("clearinghouseSubmissionId", "opaque_submission")).toBe(false);
  });
});

describe("database-backed candidate composition", () => {
  const sourceRow = {
    id: "60000000-0000-4000-8000-000000000001", organizationId: org, providerEntityId: provider,
    locationId: location as string | null, claimId: claim, billingModule: "M41", submissionId: submission,
    attemptKey: `${submission}:1`, accountReference: "synthetic-account", usage: "test",
    billingNpi: "1234567893", billingTinCiphertext: "synthetic-sealed-tin", payerId: "SYNTH-PAYER-A",
    claimType: "837I", pcn: "SYNTH-PCN-1", serviceFrom: "2026-01-01", serviceTo: "2026-01-31",
    payloadSha256: "a".repeat(64), isa13: "000000001", gs06: "1", st02: "0001",
    m23Id: null, m23OrgId: null, m23ProviderId: null, m23ClaimId: null, m23Kind: null,
    m23Control: null, m23AttemptIndex: null,
    attemptId: "70000000-0000-4000-8000-000000000001", attemptOrgId: org,
    attemptProviderId: provider, attemptUsage: "test", attemptControl: "SYNTH-PCN-1",
    attemptKind: "claim", attemptStatus: "sent",
  };
  const event: ClaimMdIdentityEvent = { accountReference: "synthetic-account", usage: "test",
    responseId: null, claimMdClaimId: null, remoteClaimId: null, claimId: null, fileId: null,
    batchId: null, pcn: "SYNTH-PCN-1", billingNpi: null, billingTin: null, payerId: null,
    claimType: null, serviceFrom: null, serviceTo: null };

  function build(rows: readonly Record<string, unknown>[], owner = org) {
    const fakeQuery = (result: readonly unknown[]) => {
      const query = { from() { return this; }, leftJoin() { return this; }, where() { return this; },
        orderBy() { return this; }, limit: async () => result,
        then: (resolve: (value: readonly unknown[]) => unknown) => Promise.resolve(result).then(resolve) };
      return query;
    };
    const tx = { select(fields: Record<string, unknown>) {
      return fakeQuery("billingModule" in fields ? rows : []);
    } };
    const snapshot = vi.fn(async (fn: (value: typeof tx) => Promise<unknown>) => fn(tx));
    const siteReader = {
      providerEntityOwners: vi.fn(async (readTx: unknown) => {
        expect(readTx).toBe(tx);
        return [{ id: provider, organizationId: owner }];
      }),
      locationOwners: vi.fn(async (readTx: unknown) => {
        expect(readTx).toBe(tx);
        return [{ id: location, providerEntityId: provider }];
      }),
    };
    const commercialSubmissionReader = vi.fn(async (readTx: unknown) => {
      expect(readTx).toBe(tx);
      return [{ id: submission, organizationId: org, providerEntityId: provider, locationId: location,
        claimId: claim, controlNumber: "SYNTH-PCN-1", payerId: "SYNTH-PAYER-A", vendor: "claimmd" }];
    });
    const cipher = { open: vi.fn(async () => "123456789") };
    const adapter = createClaimMdCandidateProvider({ readSnapshot: snapshot as never,
      siteReader: siteReader as never, commercialSubmissionReader: commercialSubmissionReader as never,
      cipher, accountReference: "synthetic-account", usage: "test", maxCandidates: 1 });
    return { adapter, snapshot, siteReader, commercialSubmissionReader, cipher };
  }

  it("uses one owner-reader snapshot and immutable M41 evidence", async () => {
    const x = build([sourceRow]);
    const found = await x.adapter.findClaimMdSubmissionCandidates(event);
    expect(found.complete).toBe(true);
    expect(found.candidates).toMatchObject([{ organizationId: org, providerEntityId: provider,
      locationId: location, module: "M41", submissionId: submission, billingTinAtSend: "123456789" }]);
    expect(x.snapshot).toHaveBeenCalledTimes(1);
    expect(x.siteReader.providerEntityOwners).toHaveBeenCalledTimes(1);
    expect(x.commercialSubmissionReader).toHaveBeenCalledTimes(1);
  });

  it("keeps M23 correlation within its owned source and does not read M41 for a Medicare-only result", async () => {
    const medicare = { ...sourceRow, billingModule: "M23", locationId: null,
      m23Id: submission, m23OrgId: org, m23ProviderId: provider, m23ClaimId: claim,
      m23Kind: "claim_837i", m23Control: "SYNTH-PCN-1", m23AttemptIndex: 1 };
    const x = build([medicare]);
    const found = await x.adapter.findClaimMdSubmissionCandidates(event);
    expect(found).toMatchObject({ complete: true, candidates: [{ module: "M23", claimId: claim,
      submissionId: submission, providerEntityId: provider }] });
    expect(x.commercialSubmissionReader).not.toHaveBeenCalled();
  });

  it("fails closed on a foreign provider owner and on a truncated search", async () => {
    const wrongOwner = build([sourceRow], "80000000-0000-4000-8000-000000000001");
    expect((await wrongOwner.adapter.findClaimMdSubmissionCandidates(event)).candidates).toEqual([]);
    expect(wrongOwner.cipher.open).not.toHaveBeenCalled();
    const overflow = build([sourceRow, { ...sourceRow, id: "60000000-0000-4000-8000-000000000002" }]);
    expect(await overflow.adapter.findClaimMdSubmissionCandidates(event)).toEqual({ candidates: [], complete: false });
    expect(overflow.cipher.open).not.toHaveBeenCalled();
  });
});
