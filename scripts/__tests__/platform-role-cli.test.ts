// The platform-role operator CLI (GAP-003 follow-up): argument parsing refuses anything that is not a
// platform role key, so a typo or a tenant key never reaches the database. The DB half (idempotent grant,
// revoke, active-membership requirement, audit trail) is proven live in auth.live.test.ts.
import { describe, expect, it } from "vitest";
import { platformRoleLabel } from "../db/lib/platform-role";
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
  });
});
