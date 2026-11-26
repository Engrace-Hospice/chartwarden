// The platform-role operator CLI (GAP-003 follow-up): argument parsing refuses anything that is not a
// platform role key, so a typo or a tenant key never reaches the database. The DB half (idempotent grant,
// revoke, active-membership requirement, audit trail) is proven live in auth.live.test.ts.
import {
  FULL_CATALOG_EXCLUDED_KEYS,
  PLATFORM_OPS_ROLE_GRANTS,
  effectivePermissionKeys,
} from "@chartwarden/auth";
import type { Client } from "pg";
import { describe, expect, it } from "vitest";
import {
  assertNoPlatformRoleConflict,
  assertSuperadminOrg,
  conflictingPlatformRoles,
  grantPlatformRole,
  platformRoleGrantKeys,
  platformRoleLabel,
  revokePlatformRole,
} from "../db/lib/platform-role";
import { parsePlatformRoleArgs } from "../db/lib/platform-role-cli";

const base = ["--email", "ops@example.test", "--org", "chartwarden-platform", "--ticket", "CHG-1"];

describe("parsePlatformRoleArgs", () => {
  it("parses a grant and a revoke", () => {
    expect(parsePlatformRoleArgs(["grant", ...base, "--role", "platform_ops"])).toEqual({
      action: "grant",
      email: "ops@example.test",
      org: "chartwarden-platform",
      role: "platform_ops",
      ticket: "CHG-1",
    });
    expect(parsePlatformRoleArgs(["revoke", ...base, "--role", "ai_safety_owner"]).action).toBe(
      "revoke",
    );
  });

  it("refuses tenant and unknown role keys", () => {
    for (const role of ["org_admin", "clinical_safety_lead", "platform_superuser"]) {
      expect(() => parsePlatformRoleArgs(["grant", ...base, "--role", role])).toThrow(
        /not a platform role/,
      );
    }
  });

  it("refuses a missing action, flag value, required flag or a malformed ticket", () => {
    expect(() => parsePlatformRoleArgs(["delete", ...base, "--role", "platform_ops"])).toThrow(
      /grant' or 'revoke/,
    );
    expect(() => parsePlatformRoleArgs(["grant", ...base, "--role"])).toThrow(/needs a value/);
    expect(() => parsePlatformRoleArgs(["grant", "--role", "platform_ops"])).toThrow(/required/);
    expect(() =>
      parsePlatformRoleArgs(["grant", ...base, "--role", "platform_ops", "--force", "x"]),
    ).toThrow(/unknown argument/);
    expect(() =>
      parsePlatformRoleArgs([
        "grant",
        "--email",
        "a@b.c",
        "--org",
        "o",
        "--role",
        "platform_ops",
        "--ticket",
        "has space",
      ]),
    ).toThrow(/--ticket/);
  });
});

describe("platformRoleLabel", () => {
  it("names template roles from the M3 catalog and the two non-template keys explicitly", () => {
    expect(platformRoleLabel("platform_ops").name).toBe("Platform Operations");
    expect(platformRoleLabel("platform_security_owner").name).toBe("Platform Security Owner");
    expect(platformRoleLabel("ai_safety_owner").name).toBe("AI Safety Owner");
    expect(platformRoleLabel("superadmin").name).toBe("Superadmin");
  });
});

describe("platformRoleGrantKeys", () => {
  it("gives superadmin exactly what the resolver grants it, never the keys withheld from the admin roles", () => {
    const keys = platformRoleGrantKeys("superadmin");
    expect([...keys].sort()).toEqual([...effectivePermissionKeys("superadmin", [], null)].sort());
    expect(keys.length).toBeGreaterThan(0);
    for (const key of FULL_CATALOG_EXCLUDED_KEYS) expect(keys).not.toContain(key);
  });

  it("leaves every other platform role on its template grants, so nothing else widens", () => {
    expect(platformRoleGrantKeys("platform_ops")).toEqual(PLATFORM_OPS_ROLE_GRANTS.platform_ops);
    expect(platformRoleGrantKeys("ai_safety_owner")).toEqual([]);
  });
});

/** A pg client that records every statement and answers from `answer`. */
function recordingDb(answer: (sql: string) => unknown[]): { db: Client; seen: string[] } {
  const seen: string[] = [];
  const db = {
    query: async (sql: string) => {
      seen.push(sql);
      const rows = answer(sql);
      return { rows, rowCount: rows.length };
    },
  } as unknown as Client;
  return { db, seen };
}

describe("superadmin belongs to ChartWarden, never a tenant", () => {
  const tenantAccountExists = (sql: string) => (sql.includes("tenant_account") ? [{ one: 1 }] : []);

  it("assertSuperadminOrg refuses an organization that has a tenant_account", async () => {
    const { db } = recordingDb(tenantAccountExists);
    await expect(assertSuperadminOrg(db, "org-tenant")).rejects.toThrow(/not a tenant/);
  });

  it("assertSuperadminOrg accepts an organization with no tenant_account", async () => {
    const { db } = recordingDb(() => []);
    await expect(assertSuperadminOrg(db, "org-platform")).resolves.toBeUndefined();
  });

  it("a grant to a tenant refuses before it writes anything", async () => {
    const { db, seen } = recordingDb(tenantAccountExists);
    await expect(
      grantPlatformRole(db, {
        organizationId: "org-tenant",
        membershipId: "membership-1",
        key: "superadmin",
        name: "Superadmin",
        description: "x",
      }),
    ).rejects.toThrow(/not a tenant/);
    expect(seen.filter((sql) => /INSERT|UPDATE|DELETE/i.test(sql))).toEqual([]);
  });

  it("other platform roles are not subject to the tenant check", async () => {
    // Every statement but a tenant_account read gets a row, so the grant runs to the end: a swallowed early error
    // could otherwise let this pass without ever reaching the point where a tenant check would have been.
    const { db, seen } = recordingDb((sql) =>
      sql.includes("tenant_account") ? [{ one: 1 }] : [{ id: "role-1", key: "platform_ops" }],
    );
    await expect(
      grantPlatformRole(db, {
        organizationId: "org-tenant",
        membershipId: "membership-1",
        key: "platform_ops",
        name: "Platform Operations",
        description: "x",
      }),
    ).resolves.toMatchObject({ roleId: "role-1" });
    expect(seen.some((sql) => sql.includes("tenant_account"))).toBe(false);
    expect(seen.some((sql) => /INSERT INTO membership_role/i.test(sql))).toBe(true);
  });
});

describe("revoking superadmin ends the holder's sessions", () => {
  // A superadmin's permission set is never cached (the resolver skips it), so a revoke takes effect on the next
  // request regardless; ending the sessions as well means one minted while they held the role does not outlive it.
  const removedOne = (sql: string) =>
    /DELETE FROM membership_role/i.test(sql) ? [{ one: 1 }] : [];

  it("deletes the user's sessions when superadmin is revoked", async () => {
    const { db, seen } = recordingDb(removedOne);
    await revokePlatformRole(db, { membershipId: "membership-1", key: "superadmin" });
    expect(seen.some((sql) => /DELETE FROM session/i.test(sql))).toBe(true);
  });

  it("leaves sessions alone when there was no binding to remove (an idempotent re-run signs nobody out)", async () => {
    const { db, seen } = recordingDb(() => []);
    const removed = await revokePlatformRole(db, {
      membershipId: "membership-1",
      key: "superadmin",
    });
    expect(removed).toBe(false);
    expect(seen.some((sql) => /DELETE FROM session/i.test(sql))).toBe(false);
  });

  it("leaves sessions alone for any other platform role", async () => {
    const { db, seen } = recordingDb(removedOne);
    await revokePlatformRole(db, { membershipId: "membership-1", key: "platform_ops" });
    expect(seen.some((sql) => /DELETE FROM session/i.test(sql))).toBe(false);
  });
});

// CW-AC-22: the go-live approver is the second party of the two-party go-live, so no account may hold it beside another onboarding role.
describe("conflictingPlatformRoles", () => {
  it("names the held roles that conflict with the one being granted, in either direction", () => {
    expect(conflictingPlatformRoles("platform_go_live_approver", ["platform_ops"])).toEqual([
      "platform_ops",
    ]);
    expect(
      conflictingPlatformRoles("platform_go_live_approver", [
        "platform_baa_steward",
        "platform_pricing_operator",
        "platform_billing_admin",
      ]),
    ).toEqual(["platform_baa_steward", "platform_pricing_operator"]);
    expect(conflictingPlatformRoles("platform_ops", ["platform_go_live_approver"])).toEqual([
      "platform_go_live_approver",
    ]);
    expect(conflictingPlatformRoles("platform_baa_steward", ["platform_go_live_approver"])).toEqual(
      ["platform_go_live_approver"],
    );
  });

  it("lets the other onboarding roles sit together, and leaves superadmin and the billing roles outside the rule", () => {
    expect(
      conflictingPlatformRoles("platform_baa_steward", [
        "platform_ops",
        "platform_pricing_operator",
      ]),
    ).toEqual([]);
    expect(conflictingPlatformRoles("platform_go_live_approver", ["superadmin"])).toEqual([]);
    expect(conflictingPlatformRoles("superadmin", ["platform_go_live_approver"])).toEqual([]);
    expect(conflictingPlatformRoles("platform_go_live_approver", ["platform_owner"])).toEqual([]);
    expect(conflictingPlatformRoles("platform_go_live_approver", [])).toEqual([]);
  });
});

describe("assertNoPlatformRoleConflict", () => {
  const dbHolding = (...keys: string[]): Client =>
    ({
      query: async (sql: string) => {
        expect(sql).toContain("m.user_id = m0.user_id"); // every membership of the account, not just the one named
        expect(sql).toContain("mr.expires_at"); // an expired grant does not hold
        return { rows: keys.map((key) => ({ key })) };
      },
    }) as unknown as Client;

  it("refuses a grant that puts a conflicting pair on one account, and says what to do", async () => {
    await expect(
      assertNoPlatformRoleConflict(
        dbHolding("platform_ops"),
        "membership-1",
        "platform_go_live_approver",
      ),
    ).rejects.toThrow(/already holds platform_ops.*one account may not hold both/);
  });

  it("allows a grant with no conflict", async () => {
    await expect(
      assertNoPlatformRoleConflict(
        dbHolding("platform_ops"),
        "membership-1",
        "platform_baa_steward",
      ),
    ).resolves.toBeUndefined();
  });
});
