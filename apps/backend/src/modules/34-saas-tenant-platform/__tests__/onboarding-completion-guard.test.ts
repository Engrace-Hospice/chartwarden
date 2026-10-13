// The tenant /complete route must not let a tenant write `done` on a step the platform verifies or owns.
import { describe, expect, it } from "vitest";
import { tenantMayCompleteStep } from "../routes/tenant/onboarding-completion-guard";

describe("tenantMayCompleteStep", () => {
  it("refuses a step the platform verifies from facts (it has a precondition)", () => {
    expect(
      tenantMayCompleteStep({
        requiredRole: "org_admin",
        preconditionDsl: "context.xeroConnected == true",
      }),
    ).toBe(false);
  });

  it("refuses a platform_ops-owned step even with no precondition", () => {
    expect(tenantMayCompleteStep({ requiredRole: "platform_ops", preconditionDsl: null })).toBe(
      false,
    );
  });

  it("allows a tenant-owned step that has nothing to verify", () => {
    expect(tenantMayCompleteStep({ requiredRole: "org_admin", preconditionDsl: null })).toBe(true);
  });
});
