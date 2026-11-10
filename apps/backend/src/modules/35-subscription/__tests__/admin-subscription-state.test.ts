// A platform operator's pause / resume / cancel of a tenant's subscription (slice 2 review fixes):
//   - the row is read under a row lock (`FOR UPDATE`) inside the write transaction, so two operators acting at once are serialized and the
//     second one judges the status the first one left;
//   - a transition the status does not allow is a typed 409 with a stable code, and writes nothing;
//   - the platform audit writer being unbound refuses the action (503 AUDIT_UNBOUND) before anything is read or written: an operator action
//     that cannot be audited is not performed.
// No database here: a recording transaction double. The live suite (m35-tenant-pricing) proves the same on the real platform carrier.
import { ChartWardenError } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import type { PlatformAuditEntry, PlatformRunner, WriteTx } from "../pricing/ports";
import type { M35WriteActor } from "../routes/actor";
import { buildDrizzleM35RouteService } from "../routes/service-drizzle";

const SUBSCRIPTION_ID = "5b000000-0000-4000-8000-000000000001";
const ORG_ID = "a1000000-0000-4000-8000-0000000000a1";
const OTHER_LIVE_ID = "5b000000-0000-4000-8000-0000000000ff";
const operator: M35WriteActor = {
  organizationId: "00000000-0000-4000-8000-000000000000",
  userId: "0a000000-0000-4000-8000-000000000001",
  roles: ["platform_ops"],
  membershipId: "0b000000-0000-4000-8000-000000000001",
  stepUpRecent: true,
};

/** A transaction whose every select returns the one subscription row, and which records the writes and the lock modes it was asked for. */
function recordingTx(
  status: string,
  extra: Record<string, unknown> = {},
  onLock: () => void = () => undefined,
  otherLive = false,
) {
  const writes: string[] = [];
  const inserted: Record<string, unknown>[] = [];
  const updated: Record<string, unknown>[] = [];
  const locks: unknown[][] = [];
  const row = { id: SUBSCRIPTION_ID, organizationId: ORG_ID, status, ...extra };
  const chain = (rows: unknown[]): unknown => {
    const proxy: unknown = new Proxy(() => undefined, {
      get: (_target, prop) => {
        if (prop === "then") return (resolve: (v: unknown) => void) => resolve(rows);
        if (prop === "for")
          return (...args: unknown[]) => {
            locks.push(args);
            onLock(); // the lock is where a second operator WAITS: whatever the clock does meanwhile happens here
            return proxy;
          };
        return () => proxy;
      },
      apply: () => proxy,
    });
    return proxy;
  };
  const tx = {
    // `select()` with no argument reads whole rows (the subscription, its plan); `select({ id })` is the one-live-per-org check (and the
    // dunning-stage lookup, which only reads `stage`): another live subscription exists only when the test says so
    select: (fields?: unknown) =>
      chain(fields ? (otherLive ? [{ id: OTHER_LIVE_ID }] : []) : [row]),
    insert: () => {
      writes.push("insert");
      const rows = chain([]) as { values: (v: Record<string, unknown>) => unknown };
      return {
        values: (v: Record<string, unknown>) => {
          inserted.push(v);
          return rows;
        },
      };
    },
    update: () => {
      writes.push("update");
      const rows = chain([]) as { set: (v: Record<string, unknown>) => unknown };
      return {
        set: (v: Record<string, unknown>) => {
          updated.push(v);
          return rows;
        },
      };
    },
    delete: () => {
      writes.push("delete");
      return chain([]);
    },
  } as unknown as WriteTx;
  return { tx, writes, inserted, updated, locks };
}

function serviceOver(
  status: string,
  withAudit = true,
  now?: () => Date,
  rowExtra: Record<string, unknown> = {},
  onLock: () => void = () => undefined,
  otherLive = false,
) {
  const recorded = recordingTx(status, rowExtra, onLock, otherLive);
  const audited: PlatformAuditEntry[] = [];
  let runnerCalls = 0;
  const platformRunner: PlatformRunner = async (fn) => {
    runnerCalls += 1;
    return fn(recorded.tx);
  };
  const service = buildDrizzleM35RouteService({} as never, {
    platformRunner,
    ...(now ? { now } : {}),
    ...(withAudit ? { audit: { record: async (_tx, entry) => void audited.push(entry) } } : {}),
  });
  return { service, ...recorded, audited, runnerCalls: () => runnerCalls };
}

type Action = "pause" | "resume" | "cancel";
const run = (service: ReturnType<typeof serviceOver>["service"], action: Action) =>
  action === "pause"
    ? service.adminPauseSubscription(operator, SUBSCRIPTION_ID, null)
    : action === "resume"
      ? service.adminResumeSubscription(operator, SUBSCRIPTION_ID)
      : service.adminCancelSubscription(operator, SUBSCRIPTION_ID);

describe("admin pause / resume / cancel refuse a transition the status does not allow, with a stable 409 code, and write nothing", () => {
  it.each([
    ["resume", "canceled", "SUBSCRIPTION_NOT_PAUSED"],
    ["resume", "active", "SUBSCRIPTION_NOT_PAUSED"],
    ["resume", "past_due", "SUBSCRIPTION_NOT_PAUSED"],
    ["pause", "canceled", "SUBSCRIPTION_CANCELED"],
    ["pause", "paused", "SUBSCRIPTION_ALREADY_PAUSED"],
    ["cancel", "canceled", "SUBSCRIPTION_CANCELED"],
  ] as const)("%s a %s subscription -> 409 %s", async (action, status, code) => {
    const t = serviceOver(status);
    const failure = await run(t.service, action).then(
      () => null,
      (e: unknown) => e,
    );
    expect(failure).toBeInstanceOf(ChartWardenError);
    expect(failure).toMatchObject({ code, statusCode: 409 });
    expect(t.writes).toEqual([]);
    expect(t.audited).toEqual([]);
  });
});

describe("admin resume of a paused subscription whose organization already has another live subscription", () => {
  it("is a typed 409 SUBSCRIPTION_OTHER_LIVE_EXISTS (never the raw unique-index failure), and writes, audits and announces nothing", async () => {
    const t = serviceOver("paused", true, undefined, {}, undefined, true);

    const failure = await run(t.service, "resume").then(
      () => null,
      (e: unknown) => e,
    );

    expect(failure).toBeInstanceOf(ChartWardenError);
    expect(failure).toMatchObject({ code: "SUBSCRIPTION_OTHER_LIVE_EXISTS", statusCode: 409 });
    expect((failure as Error).message).not.toContain(OTHER_LIVE_ID); // no ids in the envelope
    expect(t.writes).toEqual([]);
    expect(t.audited).toEqual([]);
  });

  it("resumes normally when no other subscription is live", async () => {
    const t = serviceOver("paused");

    // (the view of the double's junk plan row may not build: the writes are what is under test)
    await run(t.service, "resume").catch(() => undefined);

    expect(t.updated).toHaveLength(1);
    expect(t.audited).toHaveLength(1);
  });
});

describe("admin pause / resume / cancel read the subscription under a row lock", () => {
  it.each(["pause", "resume", "cancel"] as const)(
    "%s selects the row FOR UPDATE before it judges the status",
    async (action) => {
      // `canceled` refuses every action but the refusal comes AFTER the read, so the lock is on the record whatever the verdict
      const t = serviceOver("canceled");
      await run(t.service, action).catch(() => undefined);
      expect(t.locks).toEqual([["update"]]);
    },
  );
});

describe("admin pause / resume / cancel fail closed when the platform audit writer is unbound", () => {
  it.each(["pause", "resume", "cancel"] as const)(
    "%s -> 503 AUDIT_UNBOUND, before the runner is opened and with no write",
    async (action) => {
      // a status each action WOULD accept, so only the missing audit port can be the refusal
      const status = action === "resume" ? "paused" : "active";
      const t = serviceOver(status, false);
      await expect(run(t.service, action)).rejects.toMatchObject({
        code: "AUDIT_UNBOUND",
        statusCode: 503,
      });
      expect(t.runnerCalls()).toBe(0);
      expect(t.writes).toEqual([]);
    },
  );
});

describe("admin pause with an end date: the date must be a future instant, and the ledger keeps it", () => {
  const NOW = new Date("2026-12-01T00:00:00Z");

  it.each([
    ["in the past", "2026-11-30T23:59:59Z"],
    ["exactly now", "2026-12-01T00:00:00Z"],
  ])(
    "a pausedUntil %s -> 422 PAUSE_UNTIL_NOT_FUTURE, judged against the clock read under the lock, with no write",
    async (_label, value) => {
      const t = serviceOver("active", true, () => NOW);
      const failure = await t.service.adminPauseSubscription(operator, SUBSCRIPTION_ID, value).then(
        () => null,
        (e: unknown) => e,
      );
      expect(failure).toBeInstanceOf(ChartWardenError);
      expect(failure).toMatchObject({ code: "PAUSE_UNTIL_NOT_FUTURE", statusCode: 422 });
      expect(t.writes).toEqual([]);
      expect(t.audited).toEqual([]);
    },
  );

  it.each([
    ["words", "next tuesday"],
    [
      "no offset: read in the SERVER's zone, so a different instant on a differently configured host",
      "2026-12-15T10:00",
    ],
    ["no offset, with seconds", "2026-12-15T10:00:00"],
    ["a bare date", "2026-12-15"],
    ["an offset without a colon", "2026-12-15T10:00:00+0100"],
    ["trailing text", "2026-12-15T10:00:00Z please"],
  ])(
    "a pausedUntil that is %s -> 422 PAUSE_UNTIL_INVALID, before the runner is opened",
    async (_label, value) => {
      const t = serviceOver("active", true, () => NOW);
      const failure = await t.service.adminPauseSubscription(operator, SUBSCRIPTION_ID, value).then(
        () => null,
        (e: unknown) => e,
      );
      expect(failure).toMatchObject({ code: "PAUSE_UNTIL_INVALID", statusCode: 422 });
      expect(t.runnerCalls()).toBe(0);
      expect(t.writes).toEqual([]);
    },
  );

  it("an explicit offset is the same instant whatever the server's zone: +01:00 is stored as UTC", async () => {
    const t = serviceOver("active", true, () => NOW);
    await t.service
      .adminPauseSubscription(operator, SUBSCRIPTION_ID, "2026-12-15T10:00:00+01:00")
      .catch(() => undefined);
    const ledger = t.inserted.find((row) => row.reasonCode === "platform_ops_pause");
    expect(ledger).toMatchObject({ reasonDetail: "paused_until=2026-12-15T09:00:00.000Z" });
  });

  describe("the instant of the pause is read AFTER the row lock (an operator that waited behind a resume must not stamp a time before it)", () => {
    const T0 = Date.parse("2026-12-01T00:00:00Z");
    const T1 = Date.parse("2026-12-01T02:00:00Z"); // the other operator's resume committed; this one's lock returns

    function clockThatAdvancesAtTheLock() {
      let nowMs = T0;
      return {
        now: () => new Date(nowMs),
        advance: () => {
          nowMs = T1;
        },
      };
    }

    it("the ledger row and the subscription row carry the post-lock instant, not the one before the wait", async () => {
      const clock = clockThatAdvancesAtTheLock();
      const t = serviceOver("active", true, clock.now, {}, clock.advance);
      await t.service
        .adminPauseSubscription(operator, SUBSCRIPTION_ID, null)
        .catch(() => undefined);
      const ledger = t.inserted.find((row) => row.reasonCode === "platform_ops_pause");
      expect(ledger?.transitionedAt).toEqual(new Date(T1));
      expect(t.updated[0]).toMatchObject({ pausedAt: new Date(T1), updatedAt: new Date(T1) });
    });

    it("an end date that was in the future before the wait and is past after it is refused", async () => {
      const clock = clockThatAdvancesAtTheLock();
      const t = serviceOver("active", true, clock.now, {}, clock.advance);
      const failure = await t.service
        .adminPauseSubscription(operator, SUBSCRIPTION_ID, new Date(T0 + 3_600_000).toISOString())
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(failure).toMatchObject({ code: "PAUSE_UNTIL_NOT_FUTURE", statusCode: 422 });
      expect(t.writes).toEqual([]);
    });
  });

  it("a future pausedUntil is stored on the row's history entry as paused_until=<ISO instant>", async () => {
    const t = serviceOver("active", true, () => NOW);
    // the view the double cannot build (one row answers every select) throws AFTER the ledger insert, which is what is asserted
    await t.service
      .adminPauseSubscription(operator, SUBSCRIPTION_ID, "2026-12-15T00:00:00Z")
      .catch(() => undefined);
    const ledger = t.inserted.find((row) => row.reasonCode === "platform_ops_pause");
    expect(ledger).toMatchObject({ reasonDetail: "paused_until=2026-12-15T00:00:00.000Z" });
  });

  it("an open-ended pause writes no end date into the ledger", async () => {
    const t = serviceOver("active", true, () => NOW);
    await t.service.adminPauseSubscription(operator, SUBSCRIPTION_ID, null).catch(() => undefined);
    const ledger = t.inserted.find((row) => row.reasonCode === "platform_ops_pause");
    expect(ledger).toMatchObject({ reasonDetail: null });
  });
});

describe("a tenant cannot burn a promo redemption on a contracted subscription", () => {
  const tenant: M35WriteActor = { ...operator, organizationId: ORG_ID, roles: ["org_admin"] };

  it("applyPromoTenant on a census_banded subscription -> 403 PLAN_ASSIGNED_BY_OPERATIONS, with nothing written", async () => {
    const t = serviceOver("active", true, undefined, { tier: "census_banded" });
    const failure = await t.service.applyPromoTenant(tenant, "WELCOME10").then(
      () => null,
      (e: unknown) => e,
    );
    expect(failure).toBeInstanceOf(ChartWardenError);
    expect(failure).toMatchObject({ code: "PLAN_ASSIGNED_BY_OPERATIONS", statusCode: 403 });
    expect(t.writes).toEqual([]);
  });
});

describe("an operator cannot spend a promo redemption on a contracted subscription either", () => {
  it("adminApplyPromo on a census_banded subscription -> 409 PROMO_NOT_APPLICABLE_TO_CONTRACTED_PLAN (not the tenant's 403), nothing redeemed", async () => {
    const t = serviceOver("active", true, undefined, { tier: "census_banded" });
    const failure = await t.service.adminApplyPromo(operator, SUBSCRIPTION_ID, "WELCOME10").then(
      () => null,
      (e: unknown) => e,
    );
    expect(failure).toBeInstanceOf(ChartWardenError);
    expect(failure).toMatchObject({
      code: "PROMO_NOT_APPLICABLE_TO_CONTRACTED_PLAN",
      statusCode: 409,
    });
    expect(t.writes).toEqual([]);
  });
});
