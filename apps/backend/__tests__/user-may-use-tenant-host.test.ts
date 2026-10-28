import { describe, expect, it, vi } from "vitest";
import { createUserMayUseTenantHost } from "../src/modules/02-identity/public-tenant-db";

// The database decides "member OR portal-account holder" (migration 1149, proved live); this proves the host handling and
// that the answer is the lookup's alone, so a portal-only person (no membership) is accepted when the lookup says so.
describe("createUserMayUseTenantHost", () => {
  const belongs = vi.fn(
    async (email: string, label: string) => email === "patient@x.test" && label === "acme",
  );
  const may = createUserMayUseTenantHost({ emailBelongsToTenant: belongs }, "chartwarden.com");

  it("accepts a portal-only person on their tenant host (lower-cased email, label from the host)", async () => {
    expect(await may("Patient@X.test", "acme.chartwarden.com")).toBe(true);
    expect(belongs).toHaveBeenLastCalledWith("patient@x.test", "acme");
  });

  it("refuses another tenant's host and every non-tenant host without asking the database", async () => {
    expect(await may("patient@x.test", "other.chartwarden.com")).toBe(false);
    belongs.mockClear();
    for (const host of [
      "chartwarden.com",
      "app.chartwarden.com",
      "acme.evil.test",
      "a.b.chartwarden.com",
    ]) {
      expect(await may("patient@x.test", host), host).toBe(false);
    }
    expect(belongs).not.toHaveBeenCalled();
  });
});
