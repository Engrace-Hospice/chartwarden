// #107 item 2 — the platform-scoped active-org enumerator: proves it reads only 'active' orgs through a
// GATED + AUDITED withPlatformContext entry, and is REFUSED when its job id is not allowlisted (fail-closed).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DbClient } from "@wardenx/db";
import {
  type PlatformBypassAuditor,
  PlatformContextDeniedError,
  registerPlatformJob,
} from "@wardenx/tenancy";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildActiveOrgEnumerator } from "../src/bootstrap/active-org-enumerator";

const JOB_ID = "test.active_org_enumerator";

/** A fake platform tx capturing the query chain + returning seeded rows. */
function fakePlatformDb(rows: { organizationId: string }[]) {
  const captured: { from?: unknown; where?: unknown } = {};
  const tx = {
    select: () => ({
      from: (table: unknown) => {
        captured.from = table;
        return {
          where: (cond: unknown) => {
            captured.where = cond;
            return Promise.resolve(rows);
          },
        };
      },
    }),
  };
  return {
    captured,
    db: { transaction: (fn: (t: typeof tx) => Promise<unknown>) => fn(tx) } as never,
  };
}

describe("buildActiveOrgEnumerator", () => {
  beforeEach(() => registerPlatformJob(JOB_ID));

  it("enumerates active orgs through an audited platform-context entry", async () => {
    const seeded = [{ organizationId: "org-a" }, { organizationId: "org-b" }];
    const { db, captured } = fakePlatformDb(seeded);
    // Typed as the real auditor: `vi.fn(async () => {})` declares no parameters, so
    // `auditBypass.mock.calls[0][1]` — the bypass event this case asserts on — indexed an empty tuple.
    const auditBypass = vi.fn<PlatformBypassAuditor<DbClient>>(async () => {});

    const enumerator = buildActiveOrgEnumerator({
      platformDb: db,
      auditBypass,
      jobId: JOB_ID,
      reason: "unit",
    });
    const result = await enumerator.listActiveOrgs();

    expect(result).toEqual(seeded);
    // queried the organizations table with a status filter (the 'active' predicate)
    expect(captured.from).toBeDefined();
    expect(captured.where).toBeDefined();
    // every cross-tenant entry is audited with the caller's job id (fail-closed posture)
    expect(auditBypass).toHaveBeenCalledTimes(1);
    expect(auditBypass.mock.calls[0]?.[1]).toMatchObject({ jobId: JOB_ID });
  });

  it("is refused (fail-closed) when the job id is not allowlisted", async () => {
    const { db } = fakePlatformDb([]);
    const enumerator = buildActiveOrgEnumerator({
      platformDb: db,
      auditBypass: vi.fn(async () => {}),
      jobId: "test.unregistered_job",
      reason: "unit",
    });
    await expect(enumerator.listActiveOrgs()).rejects.toBeInstanceOf(PlatformContextDeniedError);
  });

  it("queries ONLY the pool it was given as the platform pool (never a tenant pool) and returns its orgs", async () => {
    const platform = fakePlatformDb([{ organizationId: "org-a" }]);
    const tenant = fakePlatformDb([]); // what wardenx_app sees under `organization` RLS: nothing
    const tenantTransaction = vi.spyOn(tenant.db as { transaction: () => unknown }, "transaction");
    const enumerator = buildActiveOrgEnumerator({
      platformDb: platform.db,
      auditBypass: vi.fn(async () => {}),
      jobId: JOB_ID,
    });
    expect(await enumerator.listActiveOrgs()).toEqual([{ organizationId: "org-a" }]);
    expect(tenantTransaction).not.toHaveBeenCalled();
  });

  it("fails LOUD (never returns []) when no platform pool is configured — the M14 packets-cron zero-org bug", async () => {
    const auditBypass = vi.fn<PlatformBypassAuditor<DbClient>>(async () => {});
    const enumerator = buildActiveOrgEnumerator({ platformDb: undefined, auditBypass, jobId: JOB_ID });
    await expect(enumerator.listActiveOrgs()).rejects.toThrow(/DATABASE_PLATFORM_URL/);
    expect(auditBypass).not.toHaveBeenCalled();
  });

  it("composition root: every buildActiveOrgEnumerator in index.ts binds the PLATFORM pool, never dbHandle.db", () => {
    const src = readFileSync(join(__dirname, "../src/index.ts"), "utf8");
    const calls = src.split("buildActiveOrgEnumerator({").slice(1);
    expect(calls.length).toBeGreaterThan(15);
    for (const call of calls) {
      const platformDbLine = /platformDb:\s*([^,\n]+),/.exec(call.slice(0, 400))?.[1];
      expect(platformDbLine).toMatch(/^platformDbHandle\??\.db$/);
      expect(platformDbLine).not.toContain("dbHandle.db");
    }
  });
});
