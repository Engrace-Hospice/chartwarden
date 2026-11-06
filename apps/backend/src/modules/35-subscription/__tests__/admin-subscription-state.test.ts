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
const operator: M35WriteActor = {
  organizationId: "00000000-0000-4000-8000-000000000000",
  userId: "0a000000-0000-4000-8000-000000000001",
  roles: ["platform_ops"],
  membershipId: "0b000000-0000-4000-8000-000000000001",
  stepUpRecent: true,
};

/** A transaction whose every select returns the one subscription row, and which records the writes and the lock modes it was asked for. */
function recordingTx(status: string) {
  const writes: string[] = [];
  const locks: unknown[][] = [];
  const row = { id: SUBSCRIPTION_ID, organizationId: ORG_ID, status };
  const chain = (rows: unknown[]): unknown => {
    const proxy: unknown = new Proxy(() => undefined, {
      get: (_target, prop) => {
        if (prop === "then") return (resolve: (v: unknown) => void) => resolve(rows);
        if (prop === "for")
          return (...args: unknown[]) => {
            locks.push(args);
            return proxy;
          };
        return () => proxy;
      },
      apply: () => proxy,
    });
    return proxy;
  };
  const tx = {
    select: () => chain([row]),
    insert: () => {
      writes.push("insert");
      return chain([]);
    },
    update: () => {
      writes.push("update");
      return chain([]);
    },
    delete: () => {
      writes.push("delete");
      return chain([]);
    },
  } as unknown as WriteTx;
  return { tx, writes, locks };
}

function serviceOver(status: string, withAudit = true) {
  const recorded = recordingTx(status);
  const audited: PlatformAuditEntry[] = [];
  let runnerCalls = 0;
  const platformRunner: PlatformRunner = async (fn) => {
    runnerCalls += 1;
    return fn(recorded.tx);
  };
  const service = buildDrizzleM35RouteService({} as never, {
    platformRunner,
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
