// The acknowledgment pull with a clearinghouse per organization (ADR-0053 amendment 2026-11-06): each organization is pulled from its
// OWN clearinghouse, one without any fails only itself, and the held-event helpers resolve the organization's binding too. The
// database is a fake transaction that answers every select with the rows set for the table; the SQL is proven by
// m41-commercial-ack.live.test.ts.
import { getTableName } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

const rowsByTable = new Map<string, unknown[]>();

vi.mock("@chartwarden/tenancy", async () => {
  const actual = await vi.importActual<object>("@chartwarden/tenancy");
  const chain = (rows: unknown[]): unknown =>
    new Proxy(
      {},
      {
        get: (_target, prop) =>
          prop === "then"
            ? (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
                Promise.resolve(rows).then(resolve, reject)
            : () => chain(rows),
      },
    );
  const from = (table: Parameters<typeof getTableName>[0]) =>
    chain(rowsByTable.get(getTableName(table)) ?? []);
  const tx = { select: () => ({ from }), selectDistinct: () => ({ from }) };
  return {
    ...actual,
    withOrgContext: async (_db: unknown, _ctx: unknown, fn: (tx: unknown) => Promise<unknown>) =>
      fn(tx),
  };
});

import type { ClearinghouseContext } from "@chartwarden/x12-837-client";
import type { AckBinding, AckWorkerDeps } from "./ack-apply";
import { heldQuarantineReport } from "./ack-held-replay";
import { runAckPull } from "./ack-worker";

const PE = "00000000-0000-4000-8000-0000000000e1";
const bindingOf = (vendor: string | null, reached: ClearinghouseContext[]): AckBinding => ({
  vendor,
  transport: {
    fetchAcknowledgments: async (ctx) => {
      reached.push(ctx);
      return { ok: true as const, data: { items: [], nextCursor: "c1", hasMore: false } };
    },
    fetchClaimStatus: async () => {
      throw new Error("not used");
    },
  },
});

function depsFor(bound: Record<string, string>) {
  const reached: Record<string, ClearinghouseContext[]> = {};
  const resolved: string[] = [];
  const deps: AckWorkerDeps = {
    db: {} as never,
    binding: {
      ...bindingOf(null, []),
      forOrg: async (organizationId) => {
        resolved.push(organizationId);
        const vendor = bound[organizationId] ?? null;
        reached[organizationId] ??= [];
        return bindingOf(vendor, reached[organizationId] as ClearinghouseContext[]);
      },
    },
    contexts: {
      contextFor: async (organizationId, providerEntityId, payerId) => ({
        organizationId,
        providerEntityId,
        payerId,
        correlationId: "corr",
        usage: "test",
        billingNpi: "1234567893",
      }),
    },
    cursors: {
      read: async () => ({ cursor: null, version: 0 }),
      advance: async () => true,
    },
    outbox: { publish: async () => undefined },
    activeOrgs: {
      listActiveOrgs: async () => [{ organizationId: "org-1" }, { organizationId: "org-2" }],
    },
  };
  return { deps, reached, resolved };
}

describe("runAckPull with a clearinghouse per organization", () => {
  beforeEach(() => {
    rowsByTable.clear();
    // One in-doubt submission waiting for an answer, for whichever organization is asked.
    rowsByTable.set("commercial_submission", [{ providerEntityId: PE, payerId: "CH-PAYER-1" }]);
  });

  it("pulls each organization from its own clearinghouse", async () => {
    const { deps, reached } = depsFor({ "org-1": "stedi", "org-2": "claimmd" });

    await expect(runAckPull(deps)).resolves.toMatchObject({ failures: [] });

    expect(reached["org-1"]?.map((c) => c.organizationId)).toEqual(["org-1"]);
    expect(reached["org-2"]?.map((c) => c.organizationId)).toEqual(["org-2"]);
  });

  it("fails only the organization with no clearinghouse (it has an answer waiting), and still pulls the other", async () => {
    const { deps, reached } = depsFor({ "org-1": "stedi" });

    await expect(runAckPull(deps)).rejects.toThrow(
      /^commercial acknowledgment pull failed: org org-2: CH_NOT_WIRED \(1 provider entity\(ies\) waiting for acknowledgments\)$/,
    );
    expect(reached["org-1"]).toHaveLength(1);
    expect(reached["org-2"] ?? []).toEqual([]); // nothing was asked of any transport for it
  });

  it("is quiet for an organization with none while nothing waits for an answer", async () => {
    rowsByTable.set("commercial_submission", []);
    const { deps } = depsFor({});

    await expect(runAckPull(deps)).resolves.toMatchObject({ failures: [] });
  });

  it("resolves the caller's organization in the operator helpers too (the held report names its binding)", async () => {
    const { deps, resolved } = depsFor({ "org-1": "stedi" });

    const bound = await heldQuarantineReport(deps, "org-1");
    const unbound = await heldQuarantineReport(deps, "org-2");

    expect([bound.bound, unbound.bound]).toEqual([true, false]);
    expect(resolved).toEqual(["org-1", "org-2"]);
  });
});
