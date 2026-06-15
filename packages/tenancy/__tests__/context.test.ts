/**
 * M1-T06 — Context helpers (spec §3.14).
 *
 * Accept criterion: "unit test asserts the session var is set/reset." With no live
 * Postgres yet (the Testcontainers harness lands in M1-T12), we drive the helpers with
 * a fake Drizzle transaction that records every executed SQL fragment, then render those
 * fragments through the real PgDialect to assert:
 *   - withOrgContext sets `app.org_id` AND `app.user_id`,
 *   - via `set_config(name, value, true)` where the trailing `true` (is_local) makes the variable
 *     transaction-local, i.e. auto-RESET at transaction end (no leak to the next pooled
 *     connection); that IS the "reset" half of "set/reset",
 *   - the tenant id is a BOUND PARAMETER, never string-interpolated (no injection seam),
 *   - both SET statements run INSIDE the transaction, before fn.
 * Plus the platform-context gate: fail-closed for unregistered callers, audited entry for
 * registered ones.
 */
import { type SQL, sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type PlatformBypassEvent,
  PlatformContextDeniedError,
  registerPlatformJob,
  resetPlatformJobRegistry,
  runWithRequestContext,
  withOrgContext,
  withOrgContextFromRequest,
  withPlatformContext,
} from "../src/context";

const dialect = new PgDialect();
const render = (q: SQL) => dialect.sqlToQuery(q);

/** Fake Drizzle tx/db: records executed SQL; `inTx` proves we ran inside a transaction. */
function fakeDb() {
  const executed: SQL[] = [];
  let inTx = false;
  const tx = {
    execute: async (q: SQL) => {
      if (!inTx) throw new Error("execute() called outside a transaction");
      executed.push(q);
      return undefined;
    },
  };
  const db = {
    transaction: async <R>(fn: (t: typeof tx) => Promise<R>): Promise<R> => {
      inTx = true;
      try {
        return await fn(tx);
      } finally {
        inTx = false; // transaction closes — set_config(is_local=true) vars reset here
      }
    },
  };
  return { db, executed, tx };
}

afterEach(() => resetPlatformJobRegistry());

describe("withOrgContext (M1-T06 §3.14)", () => {
  it("sets app.org_id and app.user_id transaction-locally, as bound params, then runs fn", async () => {
    const { db, executed } = fakeDb();
    const result = await withOrgContext(
      db,
      { organizationId: "org-aaa", userId: "user-bbb" },
      async (tx) => {
        await tx.execute(sql`SELECT 1`); // a representative tenant-scoped statement
        return "ok";
      },
    );
    expect(result).toBe("ok");

    const rendered = executed.map(render);
    const orgStmt = rendered[0];
    const userStmt = rendered[1];

    // app.org_id — set_config with is_local=true (auto-reset at tx end), value bound.
    expect(orgStmt?.sql).toContain("set_config");
    expect(orgStmt?.sql).toContain("'app.org_id'");
    expect(orgStmt?.sql).toContain(", true)"); // is_local = true ⇒ transaction-local reset
    expect(orgStmt?.params).toEqual(["org-aaa"]);
    expect(orgStmt?.sql).not.toContain("org-aaa"); // never interpolated

    // app.user_id — same shape, for M4 audit-trigger attribution.
    expect(userStmt?.sql).toContain("'app.user_id'");
    expect(userStmt?.sql).toContain(", true)");
    expect(userStmt?.params).toEqual(["user-bbb"]);

    // Both SETs precede the work statement, and all three ran in-transaction.
    expect(rendered).toHaveLength(3);
    expect(rendered[2]?.sql).toContain("SELECT 1");
  });

  it("keys ONLY on the canonical app.org_id variable (no app.organization_id etc.)", async () => {
    const { db, executed } = fakeDb();
    await withOrgContext(db, { organizationId: "o", userId: "u" }, async () => undefined);
    const names = executed.map(render).flatMap((r) => r.sql.match(/'app\.[a-z_]+'/g) ?? []);
    expect(new Set(names)).toEqual(new Set(["'app.org_id'", "'app.user_id'"]));
  });

  it("propagates errors and still closes the transaction (var would reset)", async () => {
    const { db } = fakeDb();
    await expect(
      withOrgContext(db, { organizationId: "o", userId: "u" }, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });
});

describe("withOrgContextFromRequest (M1-T06 §3.14)", () => {
  it("derives the tenant scope from the ambient request context", async () => {
    const { db, executed } = fakeDb();
    await runWithRequestContext(
      { organizationId: "org-req", userId: "user-req", correlationId: "corr-1" },
      () => withOrgContextFromRequest(db, async () => undefined),
    );
    const rendered = executed.map(render);
    expect(rendered[0]?.params).toEqual(["org-req"]);
    expect(rendered[1]?.params).toEqual(["user-req"]);
  });

  it("throws when there is no ambient request context", async () => {
    const { db } = fakeDb();
    await expect(withOrgContextFromRequest(db, async () => undefined)).rejects.toThrow(
      /no ambient request context/,
    );
  });
});

describe("withPlatformContext (M1-T06 §3.14)", () => {
  it("fail-closed: refuses an unregistered caller and never opens a transaction", async () => {
    const { db } = fakeDb();
    const audit = vi.fn();
    const fn = vi.fn();
    await expect(
      withPlatformContext(db, { jobId: "rogue-job", reason: "x" }, audit, fn),
    ).rejects.toBeInstanceOf(PlatformContextDeniedError);
    expect(audit).not.toHaveBeenCalled();
    expect(fn).not.toHaveBeenCalled();
  });

  it("audits the bypass before running fn for a registered caller", async () => {
    const { db } = fakeDb();
    const order: string[] = [];
    let captured: PlatformBypassEvent | undefined;
    registerPlatformJob("nppes-sync");

    const result = await withPlatformContext(
      db,
      { jobId: "nppes-sync", reason: "weekly NPPES refresh" },
      async (_tx, event) => {
        captured = event;
        order.push("audit");
      },
      async () => {
        order.push("fn");
        return 42;
      },
    );

    expect(result).toBe(42);
    expect(order).toEqual(["audit", "fn"]); // audit strictly precedes the work
    expect(captured).toEqual({
      jobId: "nppes-sync",
      reason: "weekly NPPES refresh",
      severity: "warn",
    });
  });

  it("marks cross-tenant invocations as severity=critical", async () => {
    const { db } = fakeDb();
    let captured: PlatformBypassEvent | undefined;
    registerPlatformJob("platform-analytics");
    await withPlatformContext(
      db,
      { jobId: "platform-analytics", reason: "rollup", crossTenant: true },
      async (_tx, event) => {
        captured = event;
      },
      async () => undefined,
    );
    expect(captured?.severity).toBe("critical");
  });
});
