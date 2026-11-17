import type { DbClient } from "@chartwarden/db";
import { describe, expect, it, vi } from "vitest";
import { createTenantClaimMdResponseRepository } from "./repository";

function repository(options?: {
  readonly authorizeRead?: boolean;
  readonly authorizeOutcome?: boolean;
}) {
  const db = new Proxy(
    {},
    {
      get() {
        throw new Error("database should not be reached in this test");
      },
    },
  ) as DbClient;
  return createTenantClaimMdResponseRepository({
    db,
    cipher: {
      seal: async () => ({ keyVersion: "synthetic-v1", ciphertext: Buffer.alloc(29) }),
      open: async () => "",
    } as never,
    authorizeCapture: async () => false,
    authorizeEvidenceRead: async () => options?.authorizeRead ?? false,
    authorizeOutcomeWrite: async () => options?.authorizeOutcome ?? false,
    authorizeOutcomeRead: async () => options?.authorizeRead ?? false,
    authorizePendingRead: async () => options?.authorizeRead ?? false,
  });
}

describe("tenant Claim.MD response repository boundary", () => {
  it("rejects unbounded or PHI-shaped outcome metadata before persistence", async () => {
    const repo = repository({ authorizeOutcome: true });
    await expect(
      repo.recordOutcome({
        organizationId: "org",
        accountId: "account",
        itemId: "item",
        consumerKey: "ack.consumer",
        idempotencyKey: "event-1",
        outcome: "quarantined",
      }),
    ).rejects.toMatchObject({ code: "CLAIMMD_OUTCOME_INVALID" });
    await expect(
      repo.recordOutcome({
        organizationId: "org",
        accountId: "account",
        itemId: "item",
        consumerKey: "ack.consumer",
        idempotencyKey: "event-2",
        outcome: "quarantined",
        reasonCode: "Member name: synthetic",
      }),
    ).rejects.toMatchObject({ code: "CLAIMMD_OUTCOME_INVALID" });
    await expect(
      repo.recordOutcome({
        organizationId: "org",
        accountId: "account",
        itemId: "item",
        consumerKey: "ack.consumer",
        idempotencyKey: "event-3",
        outcome: "processed",
        reasonCode: "SHOULD_NOT_BE_PRESENT",
      }),
    ).rejects.toMatchObject({ code: "CLAIMMD_OUTCOME_INVALID" });
  });

  it("denies unauthorized evidence replay before invoking the replay callback", async () => {
    const replay = vi.fn(async () => {});
    const repo = repository({ authorizeRead: false });
    await expect(
      repo.replayBatch({
        organizationId: "org",
        accountId: "account",
        batchId: "batch",
        replayKey: "review-1",
        replay,
      }),
    ).rejects.toMatchObject({ code: "CLAIMMD_REPLAY_FORBIDDEN" });
    expect(replay).not.toHaveBeenCalled();
  });

  it("requires explicit outcome-write authorization", async () => {
    const repo = repository({ authorizeOutcome: false });
    await expect(
      repo.recordOutcome({
        organizationId: "org",
        accountId: "account",
        itemId: "item",
        consumerKey: "ack.consumer",
        idempotencyKey: "event-1",
        outcome: "processed",
      }),
    ).rejects.toMatchObject({ code: "CLAIMMD_EVIDENCE_NOT_FOUND" });
  });
});
