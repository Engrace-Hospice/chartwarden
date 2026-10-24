// 11a-1 - createAppeal refuses a Medicare appeal tier on a Medicaid denial (422 PAYER_IS_MEDICAID) and writes nothing.
// Driven over a scripted fake transaction (the remittance-commands.test.ts pattern); the live suite proves it on a real DB.
import { schema } from "@chartwarden/db";
import { ChartWardenError } from "@chartwarden/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { M25WriteActor } from "../actor";
import { buildDrizzleM25WriteService } from "../write-service-drizzle";

const DC = schema.denialCase;
let denialRows: unknown[][];
let writes: string[];

function chain(resolve: () => unknown[], onWrite?: () => void) {
  const node: Record<string, unknown> = {};
  for (const m of [
    "from",
    "where",
    "limit",
    "for",
    "returning",
    "orderBy",
    "leftJoin",
    "innerJoin",
  ]) {
    node[m] = () => node;
  }
  node.set = () => node;
  node.values = () => {
    onWrite?.();
    return node;
  };
  // biome-ignore lint/suspicious/noThenProperty: a drizzle query chain is awaitable; the stub mirrors that
  node.then = (ok: (v: unknown[]) => unknown, bad: (e: unknown) => unknown) =>
    Promise.resolve().then(resolve).then(ok, bad);
  return node;
}

const fakeTx = {
  select: () => chain(() => denialRows.shift() ?? []),
  insert: () =>
    chain(
      () => [{ id: "x", version: 1 }],
      () => writes.push("insert"),
    ),
  update: () =>
    chain(
      () => [],
      () => writes.push("update"),
    ),
};

vi.mock("@chartwarden/tenancy", () => ({
  withOrgContext: (_db: unknown, _ctx: unknown, fn: (tx: unknown) => unknown) => fn(fakeTx),
}));

const actor: M25WriteActor = {
  organizationId: "00000000-0000-4000-8000-000000000001",
  userId: "u1",
  roles: ["billing_manager"],
  membershipId: "00000000-0000-4000-8000-000000000099",
  stepUpRecent: true,
  providerEntityScope: undefined,
};
const denial = { state: "open", version: 1, providerEntityId: "pe", claimId: "claim-1" };

beforeEach(() => {
  writes = [];
});

describe("createAppeal payer guard", () => {
  it("refuses a Medicaid-advice denial with 422 PAYER_IS_MEDICAID and inserts nothing", async () => {
    denialRows = [[denial], [{ adviceKind: "medicaid", source: "remittance_adjustment" }]];
    const svc = buildDrizzleM25WriteService({} as never);
    const err = await svc.createAppeal(actor, "d1", {}).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ChartWardenError);
    expect((err as ChartWardenError).code).toBe("PAYER_IS_MEDICAID");
    expect((err as ChartWardenError).statusCode).toBe(422);
    expect(writes).toEqual([]);
    expect(schema.denialCase).toBe(DC);
  });

  it("does not refuse a medicare denial on payer grounds", async () => {
    // medicare passes the guard and proceeds to the notice-date lookup (empty script rows -> a different error).
    denialRows = [[denial], [{ adviceKind: "medicare", source: "remittance_adjustment" }]];
    const svc = buildDrizzleM25WriteService({} as never);
    const err = await svc.createAppeal(actor, "d1", {}).then(
      () => null,
      (e: unknown) => e,
    );
    expect((err as ChartWardenError | null)?.code).not.toBe("PAYER_IS_MEDICAID");
  });
});
