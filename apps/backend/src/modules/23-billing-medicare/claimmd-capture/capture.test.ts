import { describe, expect, it, vi } from "vitest";
import type { AccountResponsePage } from "@chartwarden/x12-837-client";
import { createClaimMdInboxCipher } from "./cipher";
import { createClaimMdResponseCapture } from "./service";
import type { createClaimMdResponseStore, StreamLease } from "./store";

const lease: StreamLease = { streamId: "00000000-0000-4000-8000-000000000001", owner: "00000000-0000-4000-8000-000000000002", generation: 1n, accountReference: "account-a", usage: "test", cursor: "0" };
const page: AccountResponsePage = { afterCursor: "0", nextCursor: "1", body: { claim: { pcn: "synthetic" }, last_responseid: "1" }, digest: "a".repeat(64), parentCount: 1, events: [{ responseId: "1", parentIndex: 0, messageIndex: 0, digest: "b".repeat(64), state: "needs_review" }], full: false };

describe("Claim.MD response capture service", () => {
  it("does not move the cursor when persistence fails; releases the lease safely", async () => {
    const store = { acquire: vi.fn(async () => lease), commit: vi.fn(async () => { throw new Error("sensitive raw failure"); }), release: vi.fn(async (_lease: StreamLease, _error: string | null) => {}) };
    const log = vi.fn();
    const service = createClaimMdResponseCapture({ store: store as unknown as ReturnType<typeof createClaimMdResponseStore>, reader: { fetchAccountResponses: async () => ({ ok: true as const, page }) }, log });
    expect((await service.runOnce("account-a", "test")).code).toBe("CAPTURE_FAILED");
    expect(store.release).toHaveBeenCalledWith(lease, "CAPTURE_FAILED");
    expect(JSON.stringify(log.mock.calls)).not.toContain("sensitive raw failure");
  });
  it("commits before advancing local position and stops on a partial page", async () => {
    const store = { acquire: vi.fn(async () => lease), commit: vi.fn(async () => ({ cursor: "1", inserted: 1, duplicates: 0, review: 1 })), release: vi.fn(async (_lease: StreamLease, _error: string | null) => {}) };
    const service = createClaimMdResponseCapture({ store: store as unknown as ReturnType<typeof createClaimMdResponseStore>, reader: { fetchAccountResponses: async () => ({ ok: true as const, page }) } });
    expect(await service.runOnce("account-a", "test")).toMatchObject({ code: "OK", cursor: "1", events: 1, needsReview: 1 });
    expect(store.release.mock.calls[0]?.[0]).toMatchObject({ cursor: "1" });
  });
  it("seals account-wide payload with AAD and refuses wrong stream/cursor", () => {
    const key = Buffer.alloc(32, 7);
    const cipher = createClaimMdInboxCipher({ activeId: "test", byId: new Map([["test", key]]) });
    const sealed = cipher.seal(lease.streamId, "0", JSON.stringify(page.body));
    expect(sealed.toString()).not.toContain("synthetic");
    expect(cipher.open(lease.streamId, "0", sealed)).toEqual(JSON.stringify(page.body));
    expect(() => cipher.open(lease.streamId, "1", sealed)).toThrow();
  });
});
