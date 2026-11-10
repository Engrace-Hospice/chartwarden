// A tenant's own resume (POST /api/v1/subscription/resume, a non-contracted subscription) judges the organization's current subscription
// under the row lock the hourly pause-resume sweep and the org-lifecycle consumer read it under, and refuses what has nothing to resume:
//   - a CANCELED subscription is final (409 SUBSCRIPTION_CANCELED), even with a cancel-at-period-end flag still set on it (dunning drives
//     a row to `canceled` without clearing the flag): the flag must not be flipped, and the pause columns must not be written;
//   - a subscription that is neither paused nor scheduled to cancel has nothing to resume (409 SUBSCRIPTION_NOT_PAUSED);
//   - a paused one whose organization already has another live subscription cannot be resumed (409 SUBSCRIPTION_OTHER_LIVE_EXISTS,
//     never the raw failure of `subscription_org_active_uq`);
//   - a contracted plan is refused first (403): it is resumed by operations.
// No database: a recording transaction double that answers per table. The live suite (m35-org-lifecycle-consumer) proves the same, and the
// race against the sweep, on the real NOBYPASSRLS role.
import { schema } from "@chartwarden/db";
import { ChartWardenError } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import type { M35WriteActor } from "../routes/service";
import { buildDrizzleM35RouteService } from "../routes/service-drizzle";

const ORG_ID = "a1000000-0000-4000-8000-0000000000a1";
const SUB_ID = "5b000000-0000-4000-8000-000000000001";
const OTHER_LIVE_ID = "5b000000-0000-4000-8000-0000000000ff";
const actor: M35WriteActor = {
  organizationId: ORG_ID,
  userId: "0a000000-0000-4000-8000-000000000001",
  roles: ["org_admin"],
  membershipId: "0b000000-0000-4000-8000-000000000001",
  stepUpRecent: true,
};

function tenantWorld(
  sub: Record<string, unknown>,
  opts: { tier?: string; otherLive?: boolean } = {},
) {
  const row = { id: SUB_ID, organizationId: ORG_ID, planId: "plan-1", ...sub };
  const log = {
    locks: [] as unknown[][],
    writes: [] as string[],
    published: [] as unknown[],
  };
  const chain = (rows: unknown[]): unknown => {
    const proxy: unknown = new Proxy(() => undefined, {
      get: (_target, prop) => {
        if (prop === "then") return (resolve: (v: unknown) => void) => resolve(rows);
        if (prop === "for")
          return (...args: unknown[]) => {
            log.locks.push(args);
            return proxy;
          };
        return () => proxy;
      },
      apply: () => proxy,
    });
    return proxy;
  };
  const tx = {
    execute: async () => undefined,
    // `select({ ... })` names columns: the one-live-per-org check; `select()` reads whole rows
    select: (fields?: unknown) => ({
      from: (table: unknown) => {
        if (table === schema.plan) return chain([{ tier: opts.tier ?? "starter" }]);
        if (fields) return chain(opts.otherLive ? [{ id: OTHER_LIVE_ID }] : []);
        return chain([row]);
      },
    }),
    update: () => {
      log.writes.push("update");
      return { set: () => chain([]) };
    },
    insert: () => {
      log.writes.push("insert");
      return { values: () => chain([]) };
    },
    delete: () => {
      log.writes.push("delete");
      return chain([]);
    },
  };
  const db = { transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx) } as never;
  const service = buildDrizzleM35RouteService(db, {
    outbox: {
      publish: async (_tx, event) => {
        log.published.push(event);
      },
    },
  });
  return { service, log };
}

const failureOf = (work: Promise<unknown>) =>
  work.then(
    () => null,
    (error: unknown) => error,
  );

describe("a tenant's resume refuses what has nothing to resume, and writes and announces nothing when it does", () => {
  it.each([
    [
      "a canceled subscription with a cancel-at-period-end flag still set",
      { status: "canceled", cancelAtPeriodEnd: true },
    ],
    ["a canceled subscription", { status: "canceled", cancelAtPeriodEnd: false }],
  ])(
    "%s -> 409 SUBSCRIPTION_CANCELED (it is final: the flag is not flipped, nothing is written)",
    async (_name, sub) => {
      const w = tenantWorld(sub);

      const failure = await failureOf(w.service.resumeSubscription(actor));

      expect(failure).toBeInstanceOf(ChartWardenError);
      expect(failure).toMatchObject({ code: "SUBSCRIPTION_CANCELED", statusCode: 409 });
      expect(w.log.writes).toEqual([]);
      expect(w.log.published).toEqual([]);
    },
  );

  it.each(["active", "trialing", "past_due", "at_risk", "suspended"])(
    "a %s subscription that is not scheduled to cancel -> 409 SUBSCRIPTION_NOT_PAUSED",
    async (status) => {
      const w = tenantWorld({ status, cancelAtPeriodEnd: false });

      const failure = await failureOf(w.service.resumeSubscription(actor));

      expect(failure).toMatchObject({ code: "SUBSCRIPTION_NOT_PAUSED", statusCode: 409 });
      expect(w.log.writes).toEqual([]);
      expect(w.log.published).toEqual([]);
    },
  );

  it("a paused subscription whose organization already has another live subscription -> 409 SUBSCRIPTION_OTHER_LIVE_EXISTS, with no ids in the envelope", async () => {
    const w = tenantWorld({ status: "paused", cancelAtPeriodEnd: false }, { otherLive: true });

    const failure = await failureOf(w.service.resumeSubscription(actor));

    expect(failure).toBeInstanceOf(ChartWardenError);
    expect(failure).toMatchObject({ code: "SUBSCRIPTION_OTHER_LIVE_EXISTS", statusCode: 409 });
    expect((failure as Error).message).not.toContain(OTHER_LIVE_ID);
    expect(w.log.writes).toEqual([]);
    expect(w.log.published).toEqual([]);
  });

  it("a contracted plan is refused first (403): operations resume it", async () => {
    const w = tenantWorld(
      { status: "canceled", cancelAtPeriodEnd: true },
      { tier: "census_banded" },
    );

    expect(await failureOf(w.service.resumeSubscription(actor))).toMatchObject({
      code: "PLAN_ASSIGNED_BY_OPERATIONS",
      statusCode: 403,
    });
  });

  it("reads the organization's current subscription under a row lock before it judges anything", async () => {
    const w = tenantWorld({ status: "canceled", cancelAtPeriodEnd: true });

    await failureOf(w.service.resumeSubscription(actor));

    expect(w.log.locks).toEqual([["update"]]);
  });
});
