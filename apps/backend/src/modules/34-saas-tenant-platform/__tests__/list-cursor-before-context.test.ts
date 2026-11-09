// A bad cursor on an M34 list is judged BEFORE any transaction is opened. On a platform list the transaction is a `withPlatformContext`
// (a cross-tenant bypass whose entry writes an audit row), so a bad request must open no platform transaction and write no bypass audit
// row; on a tenant list it must not open the tenant's org transaction either. The answer is the route kit's 422 INVALID_CURSOR.
import type { DbClient } from "@chartwarden/db";
import { describe, expect, it } from "vitest";
import { PLATFORM_CURSOR_SCOPE, encodeKeyset } from "../routes/keyset-page";
import { createDrizzleTenantPlatformBackend } from "../routes/platform/service-drizzle";
import { createDrizzleTenantBackend } from "../routes/tenant/service-drizzle";

const ORG = "6f1f9c3e-8d2a-4b7e-9a10-2c4d5e6f7a8c";
const SESSION_ID = "6f1f9c3e-8d2a-4b7e-9a10-2c4d5e6f7a8d";
const INVALID_CURSOR = { statusCode: 422, code: "INVALID_CURSOR" };

/** A database that fails the test the moment anything touches it. */
const untouched = new Proxy(
  {},
  {
    get() {
      throw new Error("the database must not be reached for a bad cursor");
    },
  },
) as unknown as DbClient;

/** A signed cursor of the OTHER scope verifies as a cursor, but not for this list. */
const foreign = (scope: string): string =>
  encodeKeyset(scope, {
    createdAt: "2026-11-06T12:00:00.000Z",
    id: "11111111-1111-4111-8111-111111111111",
  });

describe("platform lists decode the cursor before entering the platform context", () => {
  const { service } = createDrizzleTenantPlatformBackend({
    platformDb: untouched,
    auditBypass: async () => {
      throw new Error("no platform bypass may be entered for a bad cursor");
    },
    platformJobId: "list-cursor-test",
    // the feature-flag list reads through the platform pool as well: it must not be reached for a bad cursor either
    featureFlags: {
      list: async () => {
        throw new Error("the platform pool must not be reached for a bad cursor");
      },
    },
  } as never);

  const lists: ReadonlyArray<readonly [string, (cursor: string) => Promise<unknown>]> = [
    ["listTenants", (c) => service.listTenants({}, c, 10)],
    ["listInvitations", (c) => service.listInvitations({}, c, 10)],
    ["listOnboardingTemplates", (c) => service.listOnboardingTemplates(c, 10)],
    ["listSessions", (c) => service.listSessions({}, c, 10)],
    ["listSessionEvents", (c) => service.listSessionEvents(SESSION_ID, c, 10)],
    ["listSignupIntents", (c) => service.listSignupIntents({}, c, 10)],
    ["listBaaRecords", (c) => service.listBaaRecords({}, c, 10)],
    ["listTenantExportJobs", (c) => service.listTenantExportJobs({}, c, 10)],
    ["listFeatureFlags", (c) => service.listFeatureFlags({}, c, 10)],
  ];

  it.each(lists)(
    "%s answers 422 INVALID_CURSOR for garbage and for a tenant-scoped cursor, opening no platform tx",
    async (_name, call) => {
      await expect(call("not-a-cursor")).rejects.toMatchObject(INVALID_CURSOR);
      await expect(call(foreign(ORG))).rejects.toMatchObject(INVALID_CURSOR);
    },
  );
});

describe("tenant lists decode the cursor before entering the tenant's org context", () => {
  const { service } = createDrizzleTenantBackend({ db: untouched } as never);

  const lists: ReadonlyArray<readonly [string, (cursor: string) => Promise<unknown>]> = [
    ["listConsentGrants", (c) => service.listConsentGrants(ORG as never, c, 10)],
    ["listDsarExports", (c) => service.listDsarExports(ORG as never, {}, c, 10)],
    ["listTenantExports", (c) => service.listTenantExports(ORG as never, {}, c, 10)],
    ["listBaa", (c) => service.listBaa(ORG as never, c, 10)],
  ];

  it.each(lists)(
    "%s answers 422 INVALID_CURSOR for garbage and for a platform-scoped cursor, opening no org tx",
    async (_name, call) => {
      await expect(call("not-a-cursor")).rejects.toMatchObject(INVALID_CURSOR);
      await expect(call(foreign(PLATFORM_CURSOR_SCOPE))).rejects.toMatchObject(INVALID_CURSOR);
    },
  );
});
