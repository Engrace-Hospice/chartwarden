// CW-AC-22: the console's role guard admits every onboarding role, and only those, and stays in step with the role catalog.
import { PLATFORM_ONBOARDING_ROLE_KEYS } from "@chartwarden/auth";
import { describe, expect, it } from "vitest";
import { CONSOLE_ROLE_KEYS, holdsConsoleRole } from "./console-roles";

describe("console roles", () => {
  it("are exactly the catalog's onboarding roles", () => {
    expect([...CONSOLE_ROLE_KEYS].sort()).toEqual([...PLATFORM_ONBOARDING_ROLE_KEYS].sort());
  });

  it.each(CONSOLE_ROLE_KEYS)("admits an account holding only %s", (role) => {
    expect(holdsConsoleRole([role])).toBe(true);
    expect(holdsConsoleRole(["registered_nurse", role])).toBe(true);
  });

  it("refuses a tenant role, a billing-only role and a missing session", () => {
    expect(holdsConsoleRole(["org_admin"])).toBe(false);
    expect(holdsConsoleRole(["platform_billing_admin"])).toBe(false);
    expect(holdsConsoleRole([])).toBe(false);
    expect(holdsConsoleRole(undefined)).toBe(false);
  });
});
