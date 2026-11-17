import type { AccountResponsePage, AckEvent } from "@chartwarden/x12-837-client";
import { describe, expect, it, vi } from "vitest";
import type { TenantClaimMdAccountFact } from "./account-identity";
import { createTenantClaimMdAckHandoff } from "./ack-handoff";

const account: TenantClaimMdAccountFact = {
  id: "00000000-0000-4000-8000-000000000001",
  organizationId: "00000000-0000-4000-8000-000000000002",
  tenantConfigId: "00000000-0000-4000-8000-000000000003",
  usage: "test",
  state: "verified",
  coverageStartedAt: new Date("2026-01-01T00:00:00Z"),
};
const page: AccountResponsePage = {
  afterCursor: "0",
  nextCursor: "1",
  body: {},
  rawPayload: '{"last_responseid":"1"}',
  sourceFormat: "json",
  digest: "a".repeat(64),
  parentCount: 0,
  events: [],
  full: false,
};

describe("tenant Claim.MD capture-to-ACK contract", () => {
  it("archives the already-fetched page before calling existing ACK handling", async () => {
    const order: string[] = [];
    const batch = {
      organizationId: account.organizationId,
      accountId: account.id,
      usage: account.usage,
      batchId: "00000000-0000-4000-8000-000000000004",
      sourceDigest: page.digest,
    };
    const applyExistingAckPage = vi.fn(async () => {
      order.push("ack");
    });
    const handoff = createTenantClaimMdAckHandoff({
      archive: async () => {
        order.push("archive");
        return batch;
      },
      applyExistingAckPage,
    });
    const acks: AckEvent[] = [];
    await expect(
      handoff.processFetchedPage({
        account,
        captureId: "00000000-0000-4000-8000-000000000005",
        source: page,
        acks,
      }),
    ).resolves.toEqual(batch);
    expect(order).toEqual(["archive", "ack"]);
    expect(applyExistingAckPage).toHaveBeenCalledWith({ batch, acks });
  });

  it("does not call ACK handling when archival fails; a later retry may archive the fetched page idempotently", async () => {
    const applyExistingAckPage = vi.fn(async () => {});
    const archive = vi
      .fn()
      .mockRejectedValueOnce(new Error("storage unavailable"))
      .mockResolvedValueOnce({
        organizationId: account.organizationId,
        accountId: account.id,
        usage: account.usage,
        batchId: "00000000-0000-4000-8000-000000000004",
        sourceDigest: page.digest,
      });
    const handoff = createTenantClaimMdAckHandoff({ archive, applyExistingAckPage });
    const input = {
      account,
      captureId: "00000000-0000-4000-8000-000000000005",
      source: page,
      acks: [] as AckEvent[],
    };
    await expect(handoff.processFetchedPage(input)).rejects.toThrow("storage unavailable");
    expect(applyExistingAckPage).not.toHaveBeenCalled();
    await expect(handoff.processFetchedPage(input)).resolves.toMatchObject({
      batchId: "00000000-0000-4000-8000-000000000004",
    });
    expect(archive).toHaveBeenCalledTimes(2);
    expect(applyExistingAckPage).toHaveBeenCalledTimes(1);
  });

  it("refuses mismatched archive identity before downstream ACK processing", async () => {
    const applyExistingAckPage = vi.fn(async () => {});
    const handoff = createTenantClaimMdAckHandoff({
      archive: async () => ({
        organizationId: account.organizationId,
        accountId: "wrong-account",
        usage: account.usage,
        batchId: "batch",
        sourceDigest: page.digest,
      }),
      applyExistingAckPage,
    });
    await expect(
      handoff.processFetchedPage({ account, captureId: "capture", source: page, acks: [] }),
    ).rejects.toThrow("CLAIMMD_CAPTURE_HANDOFF_IDENTITY_MISMATCH");
    expect(applyExistingAckPage).not.toHaveBeenCalled();
  });
});
