import { describe, expect, it, vi } from "vitest";
import type { ClaimMdIdentityEvent, SubmissionCandidate } from "./resolve";
import {
  type IdentityResolutionRepository,
  createClaimMdIdentityResolver,
  createClaimMdIdentityWorker,
} from "./service";

const event: ClaimMdIdentityEvent = {
  accountReference: "a",
  usage: "test",
  responseId: "r",
  claimMdClaimId: null,
  remoteClaimId: null,
  claimId: null,
  fileId: "f",
  batchId: null,
  pcn: "p",
  billingNpi: "1234567893",
  billingTin: "123456789",
  payerId: "payer",
  claimType: "837I",
  serviceFrom: null,
  serviceTo: null,
};
const candidate: SubmissionCandidate = {
  accountReference: "a",
  usage: "test",
  organizationId: "o",
  providerEntityId: "pe",
  claimId: "c",
  module: "M23",
  submissionId: "s",
  submissionAttemptId: "sa",
  receiptId: "file:f",
  claimMdClaimId: null,
  remoteClaimId: null,
  fileId: "f",
  batchId: null,
  pcn: "p",
  billingNpiAtSend: "1234567893",
  billingTinAtSend: "123456789",
  payerId: "payer",
  claimType: "837I",
  serviceFrom: null,
  serviceTo: null,
  verifiedClaimMdRoute: true,
};

describe("Claim.MD identity resolver worker", () => {
  it("persists a deterministic resolution and does not change billing state", async () => {
    const save = vi.fn(async () => true);
    const repository: IdentityResolutionRepository = {
      loadEvent: async () => ({ event, previous: null, version: 0 }),
      findCandidates: async () => [candidate],
      save,
    };
    const result =
      await createClaimMdIdentityResolver(repository).resolveClaimMdResponseIdentity("event-1");
    expect(result).toMatchObject({
      state: "resolved",
      strategy: "submission_receipt",
      candidate: {
        accountReference: "a",
        usage: "test",
        organizationId: "o",
        providerEntityId: "pe",
        claimId: "c",
        module: "M23",
        submissionId: "s",
        submissionAttemptId: "sa",
      },
    });
    expect(save).toHaveBeenCalledOnce();
  });
  it("keeps an earlier resolved association immutable when later evidence conflicts", async () => {
    const previous = {
      state: "resolved" as const,
      reason: null,
      strategy: "submission_receipt" as const,
      candidate,
      algorithmVersion: "bil1.2.v1" as const,
    };
    const save = vi.fn(async () => true);
    const repository: IdentityResolutionRepository = {
      loadEvent: async () => ({
        event: { ...event, billingNpi: "9999999999" },
        previous,
        version: 1,
      }),
      findCandidates: async () => [candidate],
      save,
    };
    expect(
      await createClaimMdIdentityResolver(repository).resolveClaimMdResponseIdentity("event-1"),
    ).toMatchObject({ state: "conflict", candidate: null });
  });
  it("does not automatically clear or reassign a conflict with a retained prior target", async () => {
    const previous = {
      state: "conflict" as const,
      reason: "EXTERNAL_IDENTIFIER_CONFLICT" as const,
      strategy: "submission_receipt" as const,
      candidate: {
        accountReference: "a",
        usage: "test" as const,
        organizationId: "o",
        providerEntityId: "pe",
        claimId: "c",
        module: "M23" as const,
        submissionId: "s",
        submissionAttemptId: "sa",
      },
      algorithmVersion: "bil1.2.v1" as const,
    };
    const save = vi.fn(async () => true);
    const repository: IdentityResolutionRepository = {
      loadEvent: async () => ({ event, previous, version: 2 }),
      findCandidates: async () => [
        { ...candidate, organizationId: "other", claimId: "other-claim" },
      ],
      save,
    };
    expect(
      await createClaimMdIdentityResolver(repository).resolveClaimMdResponseIdentity("event-1"),
    ).toEqual(previous);
    expect(save).not.toHaveBeenCalled();
  });
  it("does not claim work while disabled and bounds enabled batches", async () => {
    const claimBatch = vi.fn(async () => []);
    const queue = { claimBatch, complete: async () => {}, retry: async () => {} };
    const resolver = createClaimMdIdentityResolver({
      loadEvent: async () => null,
      findCandidates: async () => [],
      save: async () => true,
    });
    const disabled = createClaimMdIdentityWorker({ enabled: false, queue, resolver });
    expect(await disabled.runOnce()).toEqual({ processed: 0, failed: 0 });
    expect(claimBatch).not.toHaveBeenCalled();
    const enabled = createClaimMdIdentityWorker({
      enabled: true,
      queue,
      resolver,
      batchSize: 1000,
    });
    await enabled.runOnce();
    expect(claimBatch).toHaveBeenCalledWith(100, 60_000);
  });
  it("persists no guessed unique match when the candidate adapter reports a truncated set and fences saves by lease token", async () => {
    const save = vi.fn(async () => true);
    const repository: IdentityResolutionRepository = {
      loadEvent: async () => ({ event, previous: null, version: 4 }),
      findCandidates: async () => ({ candidates: [candidate], complete: false }),
      save,
    };
    const resolver = createClaimMdIdentityResolver(repository);
    const queue = {
      claimBatch: async () => [{ eventId: "event-1", version: 4, leaseToken: "lease-token" }],
      complete: vi.fn(async () => {}),
      retry: vi.fn(async () => {}),
    };
    const worker = createClaimMdIdentityWorker({ enabled: true, queue, resolver });
    await worker.runOnce();
    expect(save).toHaveBeenCalledWith(
      "event-1",
      4,
      expect.objectContaining({ state: "ambiguous", reason: "CANDIDATE_LIMIT_EXCEEDED" }),
      "lease-token",
    );
    expect(queue.complete).toHaveBeenCalledWith("event-1", 4, "lease-token");
  });
});
