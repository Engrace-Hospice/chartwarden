// "An organization's clearinghouse choice just changed": the settle hook the tenant's and the platform's clearinghouse routes call
// after commit. A tenant still being onboarded gets the advance pass; a LIVE tenant has nothing for the sweep to settle, but a
// change of choice still has to reach the billing-mode sync (a live tenant that switches to outside stops paying the percentage).
import type { DbClient } from "@chartwarden/db";
import { describe, expect, it, vi } from "vitest";
import { createSettleOnboardingForOrg } from "../onboarding/settle-for-org";

const ORG = "22222222-2222-4222-8222-222222222222";

/** A database whose tenant_account lookup answers `status` (null = no account), however the org context is opened. */
function stubDb(status: string | null): DbClient {
  const select = () => ({
    from: () => ({
      where: () => ({ limit: async () => (status === null ? [] : [{ id: "ta-1", status }]) }),
    }),
  });
  const tx: Record<string, unknown> = {
    select,
    transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx),
    execute: async () => undefined,
  };
  return {
    select,
    transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx),
  } as unknown as DbClient;
}

describe("createSettleOnboardingForOrg", () => {
  it("runs the advance pass for a tenant that is onboarding or provisioning", async () => {
    for (const status of ["onboarding", "provisioning"]) {
      const advance = vi.fn(async () => undefined);
      const afterChange = vi.fn(async () => undefined);
      await createSettleOnboardingForOrg({ db: stubDb(status), advance, afterChange })(ORG);
      expect(advance, status).toHaveBeenCalledWith({
        tenantAccountId: "ta-1",
        organizationId: ORG,
      });
      expect(afterChange, status).not.toHaveBeenCalled();
    }
  });

  it("does not advance a live tenant, but still tells afterChange so the billing mode can follow the choice", async () => {
    const advance = vi.fn(async () => undefined);
    const afterChange = vi.fn(async () => undefined);
    await createSettleOnboardingForOrg({ db: stubDb("active"), advance, afterChange })(ORG);
    expect(advance).not.toHaveBeenCalled();
    expect(afterChange).toHaveBeenCalledWith(ORG);
  });

  it("does nothing for an organization with no tenant account", async () => {
    const advance = vi.fn(async () => undefined);
    const afterChange = vi.fn(async () => undefined);
    await createSettleOnboardingForOrg({ db: stubDb(null), advance, afterChange })(ORG);
    expect(advance).not.toHaveBeenCalled();
    expect(afterChange).not.toHaveBeenCalled();
  });

  it("works without afterChange", async () => {
    await expect(
      createSettleOnboardingForOrg({ db: stubDb("active"), advance: async () => undefined })(ORG),
    ).resolves.toBeUndefined();
  });
});
