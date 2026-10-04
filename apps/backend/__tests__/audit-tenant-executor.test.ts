// apps/backend/__tests__/audit-tenant-executor.test.ts — the M4 audit-of-audit sink writes inside the
// tenant's context.
//
// Regression: `mountAuditRoutes` used to pass the bare pooled `db` as the `audit.elevated_access` sink.
// A pooled connection that earlier ran a `withOrgContext` transaction keeps `app.org_id = ''`, so
// `audit_event_org_append` cast `''::uuid` and every elevated audit read 500'd ("invalid input syntax
// for type uuid"). The sink must open its own org-scoped transaction from the row it writes.
import { schema } from "@wardenx/db";
import type { DbClient } from "@wardenx/db";
import { describe, expect, it } from "vitest";
import { createTenantAuditExecutor } from "../src/modules/04-audit/index";

const ORG = "b991d9e6-c459-4831-9543-cc00fb4cf6e2";
const USER = "764f602a-3298-4128-a846-9906d9c8d7a0";

function fakeDb() {
  const calls: string[] = [];
  const tx = {
    execute: async () => {
      calls.push("tx.execute");
    },
    insert: () => ({
      values: async () => {
        calls.push("tx.insert");
      },
    }),
  };
  const db = {
    transaction: async (fn: (t: typeof tx) => Promise<unknown>) => {
      calls.push("begin");
      const out = await fn(tx);
      calls.push("commit");
      return out;
    },
    insert: () => ({
      values: async () => {
        calls.push("db.insert");
      },
    }),
  };
  return { db: db as unknown as DbClient, calls };
}

describe("M4 createTenantAuditExecutor", () => {
  it("writes a tenant audit row inside an org-scoped transaction (GUCs set first)", async () => {
    const { db, calls } = fakeDb();
    await createTenantAuditExecutor(db)
      .insert(schema.auditEvents)
      .values({ organizationId: ORG, actorUserId: USER } as never);
    expect(calls[0]).toBe("begin");
    expect(calls.indexOf("tx.execute")).toBeGreaterThan(0);
    expect(calls.indexOf("tx.insert")).toBeGreaterThan(calls.indexOf("tx.execute"));
    expect(calls).not.toContain("db.insert");
    expect(calls.at(-1)).toBe("commit");
  });

  it("keeps the bare client for a platform event with no organization", async () => {
    const { db, calls } = fakeDb();
    await createTenantAuditExecutor(db)
      .insert(schema.auditEvents)
      .values({ organizationId: null } as never);
    expect(calls).toEqual(["db.insert"]);
  });
});
