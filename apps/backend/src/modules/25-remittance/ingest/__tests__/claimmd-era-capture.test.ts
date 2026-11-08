import { discoverClaimMdEraSnapshot } from "@chartwarden/x12-837-client";
import { describe, expect, it } from "vitest";
import { createClaimMdEraCapture } from "../claimmd-era-capture";

const page = {
  afterEraId: "0",
  lastEraId: "1",
  page: 1,
  items: [{ eraId: "1", digest: "a".repeat(64), metadata: { eraid: "1" } }],
  digest: "b".repeat(64),
};
const lease = {
  streamId: "stream",
  owner: "lease",
  generation: 2n,
  accountReference: "central",
  usage: "test" as const,
  cursor: "0",
};

describe("BIL-1.4 capture orchestration", () => {
  it("durably discovers then captures encrypted-source inputs and never calls posting", async () => {
    expect(
      await discoverClaimMdEraSnapshot({
        reader: {
          async list() {
            return { ok: true as const, page };
          },
        },
        commit: { async commit() {} },
        accountReference: "central",
        usage: "test",
        cursor: "0",
        leaseGeneration: 2n,
      }),
    ).toMatchObject({ ok: true });
    const actions: string[] = [];
    const worker = createClaimMdEraCapture({
      store: {
        async acquire() {
          return lease;
        },
        async renew() {},
        async commitDiscovery(_lease: typeof lease, input: { readonly nextEraId: string }) {
          actions.push(`commit:${input.nextEraId}`);
        },
        async pendingCapture() {
          return ["1"];
        },
        async recordCapture(
          _lease: typeof lease,
          input: { readonly eraId: string; readonly files: readonly string[] },
        ) {
          actions.push(`captured:${input.eraId}:${input.files.length}`);
        },
        async recordCaptureFailure() {
          actions.push("failure");
        },
        async release() {
          actions.push("release");
        },
      } as never,
      reader: {
        async list() {
          return { ok: true as const, page };
        },
        async download835() {
          return {
            ok: true as const,
            eraId: "1",
            files: ["synthetic 835"],
            metadata: {},
            digest: "c".repeat(64),
          };
        },
        async details() {
          return { ok: true as const, eraId: "1", details: { eraid: "1" }, digest: "d".repeat(64) };
        },
      } as never,
    });
    expect(await worker.runOnce("central", "test")).toMatchObject({
      code: "OK",
      discovered: 1,
      captured: 1,
      failed: 0,
    });
    expect(actions).toEqual(["commit:1", "captured:1:1", "release"]);
    expect(actions.some((action) => action.includes("post"))).toBe(false);
  });

  it("preserves discovered work when vendor detail download fails", async () => {
    const actions: string[] = [];
    const worker = createClaimMdEraCapture({
      store: {
        async acquire() {
          return lease;
        },
        async renew() {},
        async commitDiscovery() {
          actions.push("commit");
        },
        async pendingCapture() {
          return ["1"];
        },
        async recordCapture() {
          actions.push("captured");
        },
        async recordCaptureFailure(_lease: typeof lease, _id: string, code: string) {
          actions.push(`retry:${code}`);
        },
        async release() {
          actions.push("release");
        },
      } as never,
      reader: {
        async list() {
          return { ok: true as const, page };
        },
        async download835() {
          return { ok: false as const, code: "TRANSPORT" as const };
        },
        async details() {
          return { ok: true as const, eraId: "1", details: {}, digest: "d".repeat(64) };
        },
      } as never,
    });
    expect(await worker.runOnce("central", "test")).toMatchObject({
      code: "CAPTURE_PARTIAL",
      discovered: 1,
      captured: 0,
      failed: 1,
    });
    expect(actions).toContain("retry:TRANSPORT");
    expect(actions).toContain("release");
  });
});
