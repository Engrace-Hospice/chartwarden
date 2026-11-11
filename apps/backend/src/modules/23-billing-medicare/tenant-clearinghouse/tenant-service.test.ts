// The tenant routes' service over a fake database: which hook says what (CH-5). The post-commit onboarding settle and the `denied`
// audit row of a refused credential are different failures, so each has its own hook and its own log line at the composition root.
import type { DbClient } from "@chartwarden/db";
import { describe, expect, it } from "vitest";
import type { M23WriteActor } from "../routes/actor";
import type { ClearinghouseAuditPort } from "./audit-port";
import { accountInUse } from "./credential-reservation";
import type { TenantClearinghouseService } from "./service";
import { buildDrizzleTenantClearinghouseRouteService } from "./tenant-service";

const ORG = "11111111-1111-4111-8111-111111111111";
const ACTOR: M23WriteActor = {
  organizationId: ORG,
  userId: "33333333-3333-4333-8333-333333333333",
  membershipId: "44444444-4444-4444-8444-444444444444",
  roles: ["org_admin"],
  stepUpRecent: true,
  actorKind: "human",
};

/** A transaction whose every select answers no row, and whose statements are accepted: the store only needs `find` to see none. */
const fakeDb = (): DbClient => {
  const tx = {
    execute: async () => [],
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
  };
  return { transaction: async (fn: (t: typeof tx) => unknown) => fn(tx) } as unknown as DbClient;
};

const BODY = { vendor: "stedi", mode: "production", secret: "fake-key-not-a-secret#1" } as const;

describe("buildDrizzleTenantClearinghouseRouteService hooks", () => {
  it("a failed `denied` audit write goes to its own hook, never the onboarding-settle one, and the caller still gets the refusal", async () => {
    const settleFailures: unknown[] = [];
    const auditFailures: { cause: unknown; organizationId: string }[] = [];
    const refused = accountInUse();
    const audit: ClearinghouseAuditPort = {
      record: async () => {
        throw new Error("audit store down");
      },
    };
    const service = {
      put: async () => {
        throw refused;
      },
    } as unknown as TenantClearinghouseService;
    const route = buildDrizzleTenantClearinghouseRouteService({
      db: fakeDb(),
      service,
      audit,
      logError: (cause) => void settleFailures.push(cause),
      logRefusalAuditError: (cause, context) => void auditFailures.push({ cause, ...context }),
    });

    await expect(route.put(ACTOR, BODY, undefined)).rejects.toBe(refused);

    expect(settleFailures).toEqual([]);
    expect(auditFailures).toHaveLength(1);
    expect(auditFailures[0]).toMatchObject({ organizationId: ORG });
    expect((auditFailures[0]?.cause as Error).message).toBe("audit store down");
  });

  it("a failed post-commit settle goes to logError, never the audit hook, and the change still succeeds", async () => {
    const settleFailures: { organizationId: string }[] = [];
    const auditFailures: unknown[] = [];
    const service = {
      put: async () => ({ created: true, view: { status: "draft" }, changedFields: [] }),
    } as unknown as TenantClearinghouseService;
    const route = buildDrizzleTenantClearinghouseRouteService({
      db: fakeDb(),
      service,
      audit: { record: async () => undefined },
      onChanged: async () => {
        throw new Error("wizard advance failed");
      },
      logError: (_cause, context) => void settleFailures.push(context),
      logRefusalAuditError: (cause) => void auditFailures.push(cause),
    });

    await expect(route.put(ACTOR, BODY, undefined)).resolves.toMatchObject({ created: true });

    expect(settleFailures).toEqual([{ organizationId: ORG }]);
    expect(auditFailures).toEqual([]);
  });
});

/** A fake database whose config row exists (the audit row names it) and whose one transaction is exposed for identity checks. */
const rowDb = (): { db: DbClient; tx: object } => {
  const tx = {
    execute: async () => [],
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ id: "cfg-1" }] }) }) }),
  };
  return {
    tx,
    db: { transaction: async (fn: (t: typeof tx) => unknown) => fn(tx) } as unknown as DbClient,
  };
};

const writesService = {
  put: async () => ({ created: false, view: { status: "draft" }, changedFields: ["vendor"] }),
  recordBaa: async () => ({ view: { status: "draft" }, changedFields: ["baa"] }),
  prepareVerify: async () => ({
    version: 1,
    vendor: "claimmd",
    mode: "test",
    evidence: null,
    secret: "s",
  }),
  runProbe: async () => "ok",
  completeVerify: async () => ({ view: { status: "verified" }, test: { outcome: "ok" } }),
  activate: async () => ({ status: "active" }),
} as unknown as TenantClearinghouseService;

describe("buildDrizzleTenantClearinghouseRouteService: onOnboardingDataChanged (a write voids a pending go-live attestation)", () => {
  const writes: [
    string,
    (r: ReturnType<typeof buildDrizzleTenantClearinghouseRouteService>) => Promise<unknown>,
  ][] = [
    ["put", (r) => r.put(ACTOR, BODY, undefined)],
    [
      "recordBaa",
      (r) =>
        r.recordBaa(ACTOR, {
          heldBy: "tenant",
          effectiveDate: "2026-01-02",
          documentRef: "BAA folder",
        }),
    ],
    ["verify", (r) => r.verify(ACTOR, {})],
    ["activate", (r) => r.activate(ACTOR)],
  ];

  it.each(writes)(
    "%s runs it once, on the write's own transaction, naming the actor and the organization",
    async (_name, write) => {
      const { db, tx } = rowDb();
      const calls: { tx: unknown; change: unknown }[] = [];
      const route = buildDrizzleTenantClearinghouseRouteService({
        db,
        service: writesService,
        audit: { record: async () => undefined },
        onOnboardingDataChanged: async (t, change) => void calls.push({ tx: t, change }),
      });

      await write(route);

      expect(calls).toHaveLength(1);
      expect(calls[0]?.tx).toBe(tx);
      expect(calls[0]?.change).toEqual({
        organizationId: ORG,
        userId: ACTOR.userId,
        membershipId: ACTOR.membershipId,
      });
    },
  );

  it.each(writes)(
    "%s: a hook that throws fails the write and the post-commit settle never runs",
    async (_name, write) => {
      const settled: string[] = [];
      const route = buildDrizzleTenantClearinghouseRouteService({
        db: rowDb().db,
        service: writesService,
        audit: { record: async () => undefined },
        onOnboardingDataChanged: async () => {
          throw new Error("void failed");
        },
        onChanged: async (organizationId) => void settled.push(organizationId),
      });

      await expect(write(route)).rejects.toThrow("void failed");

      expect(settled).toEqual([]);
    },
  );

  it("a refused write (the service throws) never reaches the hook", async () => {
    const calls: unknown[] = [];
    const route = buildDrizzleTenantClearinghouseRouteService({
      db: rowDb().db,
      service: {
        activate: async () => {
          throw new Error("CLEARINGHOUSE_NOT_VERIFIED");
        },
      } as unknown as TenantClearinghouseService,
      audit: { record: async () => undefined },
      onOnboardingDataChanged: async (_t, change) => void calls.push(change),
    });

    await expect(route.activate(ACTOR)).rejects.toThrow("CLEARINGHOUSE_NOT_VERIFIED");

    expect(calls).toEqual([]);
  });

  it("is optional: a service built without it writes exactly as before", async () => {
    const route = buildDrizzleTenantClearinghouseRouteService({
      db: rowDb().db,
      service: writesService,
      audit: { record: async () => undefined },
    });

    await expect(route.activate(ACTOR)).resolves.toMatchObject({ status: "active" });
  });
});
