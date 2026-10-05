// M33 worker recipient port: the role read feeding the §4.7.2 role-share ladder applies the SAME filter as every
// other role read (enabled role, grant in THIS org, unexpired, `roleConfersKey`). Unit test over a scripted db —
// the SQL predicates are asserted by the rows the fake hands back being re-filtered in code (defence in depth).
import type { DbClient } from "@wardenx/db";
import { describe, expect, it } from "vitest";
import { buildM33WorkerPorts } from "../src/modules/33-reporting/jobs/m33-jobs";

const ORG = "org-1";
const OTHER_ORG = "org-2";
const MEMBER = "m-recipient";
const VIEW = "view-1";
const NOW = new Date("2026-10-04T00:00:00Z");

interface RoleRow {
  key: string;
  expiresAt: Date | null;
  enabled: boolean;
  grantOrganizationId: string;
  roleOrganizationId: string | null;
  category: string;
}

const roleRow = (over: Partial<RoleRow> = {}): RoleRow => ({
  key: "nurse",
  expiresAt: null,
  enabled: true,
  grantOrganizationId: ORG,
  roleOrganizationId: null,
  category: "platform",
  ...over,
});

/** A db whose three reads (membership, view, roles) resolve to scripted rows in call order. */
const scriptedDb = (roleRows: RoleRow[]): DbClient => {
  const view = {
    id: VIEW,
    organizationId: ORG,
    ownerMembershipId: "m-owner",
    shareScope: "role",
    shareRoleKeys: ["nurse", "platform_support"],
  };
  // Read order: membership, view, roles, then the snapshot gate's own view-owner lookup.
  const results: unknown[][] = [
    [{ status: "active", organizationId: ORG }],
    [view],
    roleRows,
    [view],
  ];
  const chain = (rows: unknown[]) => {
    const c: Record<string, unknown> = {};
    for (const m of ["from", "innerJoin", "where", "limit"]) c[m] = () => c;
    // biome-ignore lint/suspicious/noThenProperty: drizzle query builders are awaitable; the fake mirrors that.
    c.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(rows).then(res, rej);
    return c;
  };
  return { select: () => chain(results.shift() ?? []) } as unknown as DbClient;
};

const entitled = (roleRows: RoleRow[]): Promise<boolean> =>
  buildM33WorkerPorts({
    connection: { host: "127.0.0.1", port: 6379 },
    db: scriptedDb(roleRows),
    now: () => NOW,
    jobOrganizationId: ORG,
    adminMemberships: { adminMembershipIds: () => new Set([MEMBER]) },
  }).scheduledRun.recipients.isRecipientEntitled(MEMBER, ORG, VIEW);

describe("M33 scheduled-run recipient role read", () => {
  it("honours a live platform role shared on the view", async () => {
    expect(await entitled([roleRow()])).toBe(true);
  });

  it("a disabled role confers nothing", async () => {
    expect(await entitled([roleRow({ enabled: false })])).toBe(false);
  });

  it("a grant from another organization confers nothing", async () => {
    expect(await entitled([roleRow({ grantOrganizationId: OTHER_ORG })])).toBe(false);
  });

  it("a tenant role squatting a platform key confers nothing", async () => {
    expect(
      await entitled([
        roleRow({ key: "platform_support", roleOrganizationId: ORG, category: "custom" }),
      ]),
    ).toBe(false);
  });

  it("an expired grant confers nothing", async () => {
    expect(await entitled([roleRow({ expiresAt: new Date("2026-10-03T00:00:00Z") })])).toBe(false);
  });
});
