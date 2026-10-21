import type { SQL } from "drizzle-orm";
// apps/backend/__tests__/m6-f2f-clinician-roles.test.ts — GAP-022: the F2F performer-role reader derives
// roles from ACTIVE memberships only (pending / suspended / revoked yield nothing), the same posture as
// M30's member-roles reader.
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";

const captured: { where: SQL | null } = { where: null };

vi.mock("@chartwarden/tenancy", () => ({
  withOrgContext: async (_db: unknown, _ctx: unknown, fn: (tx: unknown) => unknown) => {
    const chain = {
      from: () => chain,
      leftJoin: () => chain,
      where: (condition: SQL) => {
        captured.where = condition;
        return Promise.resolve([]);
      },
    };
    return fn({ select: () => chain });
  },
}));

import { buildF2fClinicianRoleReader } from "../src/bootstrap/f2f-clinician-roles";

describe("buildF2fClinicianRoleReader (GAP-022)", () => {
  it("filters memberships to status = active only", async () => {
    const reader = buildF2fClinicianRoleReader({} as never);

    const result = await reader.roleKeysForUser("org-1", "user-1");

    expect(result).toBeNull();
    const built = new PgDialect().sqlToQuery(captured.where as SQL);
    expect(built.params).toContain("active");
    expect(built.params).not.toContain("revoked");
    expect(built.sql).not.toContain("<>");
  });
});
