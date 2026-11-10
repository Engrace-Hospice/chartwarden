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
