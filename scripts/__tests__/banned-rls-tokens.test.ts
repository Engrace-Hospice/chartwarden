import { describe, expect, it } from "vitest";
import { prescribesBannedRlsToken } from "../lib/banned-rls-tokens";

describe("module-docs BANNED rule (ADR-0010 D2)", () => {
  it("flags a spec sample that prescribes withTenantContext", () => {
    expect(prescribesBannedRlsToken("  await withTenantContext(db, { organizationId }, fn)")).toBe(
      true,
    );
  });
  it("flags a policy that keys on app.tenant_id", () => {
    expect(
      prescribesBannedRlsToken("USING (tenant_id = current_setting('app.tenant_id')::uuid)"),
    ).toBe(true);
  });
  it("allows the canonical spellings", () => {
    expect(prescribesBannedRlsToken("withOrgContext(db, { organizationId }, fn)")).toBe(false);
    expect(prescribesBannedRlsToken("current_setting('app.org_id', true)::uuid")).toBe(false);
  });
  it("allows a changelog line that names the spelling to say it is removed", () => {
    expect(
      prescribesBannedRlsToken(
        "RLS variable normalized to `app.org_id`; `withTenantContext` → `withOrgContext`",
      ),
    ).toBe(false);
    expect(prescribesBannedRlsToken("the banned `app.tenant_id` spelling")).toBe(false);
  });
});
