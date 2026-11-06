// The send-gate view names the clearinghouse of the CALLER'S organization when the platform binding is per organization
// (ADR-0053 amendment 2026-11-06). The database is a fake transaction that answers every select with the rows set for the table;
// the SQL is proven by m41-commercial-submission.live.test.ts.
import { getTableName } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

const rowsByTable = new Map<string, unknown[]>();
const resolvedFor: string[] = [];

vi.mock("@chartwarden/tenancy", async () => {
  const actual = await vi.importActual<object>("@chartwarden/tenancy");
  // Any chain of query-builder calls ends in the rows set for the table `from` named.
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
  const tx = {
    select: () => ({
      from: (table: Parameters<typeof getTableName>[0]) =>
        chain(rowsByTable.get(getTableName(table)) ?? []),
    }),
  };
  return {
    ...actual,
    withOrgContext: async (_db: unknown, _ctx: unknown, fn: (tx: unknown) => Promise<unknown>) =>
      fn(tx),
  };
});

import {
  type CommercialClearinghouseBinding,
  buildCommercialSubmissionService,
} from "./submission-service";
import type { CommercialActor, CommercialClaimSeams } from "./types";

const ORG_A = "00000000-0000-4000-8000-0000000000a1";
const ORG_B = "00000000-0000-4000-8000-0000000000b1";
const ORG_C = "00000000-0000-4000-8000-0000000000c1";
const CLAIM = "00000000-0000-4000-8000-0000000000d1";
const PLAN = "00000000-0000-4000-8000-0000000000e1";

const actorOf = (organizationId: string) =>
  ({
    organizationId,
    userId: "",
    billingScope: { all: true, providerEntityIds: [] },
  }) as unknown as CommercialActor;

const perOrg: CommercialClearinghouseBinding = {
  vendor: null,
  forOrg: async (organizationId) => {
    resolvedFor.push(organizationId);
    const vendor = ({ [ORG_A]: "stedi", [ORG_B]: "claimmd" } as Record<string, string>)[
      organizationId
    ];
    return { vendor: vendor ?? null };
  },
};

describe("send-gate view with a clearinghouse per organization", () => {
  beforeEach(() => {
    resolvedFor.length = 0;
    rowsByTable.clear();
    rowsByTable.set("commercial_claim", [
      {
        id: CLAIM,
        organizationId: ORG_A,
        patientId: "p1",
        providerEntityId: "pe1",
        planId: PLAN,
        state: "draft",
        serviceTo: "2026-10-31",
        clearinghousePayerId: null,
      },
    ]);
    rowsByTable.set("commercial_payer_plan", [{ id: PLAN, payerId: "payer-1" }]);
  });

  const service = (binding: CommercialClearinghouseBinding) =>
    buildCommercialSubmissionService(
      {} as never,
      { now: () => new Date("2026-11-05T00:00:00Z") } as unknown as CommercialClaimSeams,
      binding,
    );

  it("reports each organization's own clearinghouse key (and null for one with none)", async () => {
    const svc = service(perOrg);

    expect((await svc.sendGate(actorOf(ORG_A), CLAIM)).clearinghouseKey).toBe("stedi");
    expect((await svc.sendGate(actorOf(ORG_B), CLAIM)).clearinghouseKey).toBe("claimmd");
    const none = await svc.sendGate(actorOf(ORG_C), CLAIM);
    expect(none.clearinghouseKey).toBeNull();
    expect(none.canSubmit).toBe(false);
    expect(resolvedFor).toEqual([ORG_A, ORG_B, ORG_C]);
  });

  it("keeps a platform binding without forOrg exactly as it was", async () => {
    const view = await service({ vendor: "claimmd" }).sendGate(actorOf(ORG_A), CLAIM);

    expect(view.clearinghouseKey).toBe("claimmd");
  });
});
