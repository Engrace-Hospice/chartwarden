// The onboarding-template catalog's upsert (in-memory twin): a canonical template is migration-owned and never overwritten.
import { ChartWardenError } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import { createInMemoryTenantPlatformBackend } from "../routes/platform/service";

const ARGS = {
  title: "Renamed",
  description: null,
  canonicalOrder: 9,
  isCanonical: false,
  reason: "Rename a catalog step, ticket CHG-5521",
  operatorMembershipId: "ops-m",
};

describe("upsertOnboardingTemplate", () => {
  it("refuses a canonical key with 409 ONBOARDING_TEMPLATE_CANONICAL and leaves it canonical", async () => {
    const { service } = createInMemoryTenantPlatformBackend({
      templates: [{ key: "baa_executed", title: "BAA executed", isCanonical: true }],
    });
    const err = await service
      .upsertOnboardingTemplate("ops", { ...ARGS, key: "baa_executed" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChartWardenError);
    expect(err).toMatchObject({ code: "ONBOARDING_TEMPLATE_CANONICAL", statusCode: 409 });
    const page = await service.listOnboardingTemplates(undefined, 50);
    expect(page.items.find((t) => t.key === "baa_executed")).toMatchObject({
      title: "BAA executed",
      isCanonical: true,
    });
  });

  it("adds and then edits a non-canonical template", async () => {
    const { service } = createInMemoryTenantPlatformBackend({});
    await service.upsertOnboardingTemplate("ops", { ...ARGS, key: "custom", title: "Custom" });
    const edited = await service.upsertOnboardingTemplate("ops", { ...ARGS, key: "custom" });
    expect(edited).toMatchObject({ key: "custom", title: "Renamed", isCanonical: false });
  });

  // A step becomes canonical (it then gates go-live for every tenant) only by migration: the upsert never promotes one, new or existing.
  it("refuses to make a template canonical, on an existing key and on a new one, and changes nothing", async () => {
    const { service } = createInMemoryTenantPlatformBackend({});
    await service.upsertOnboardingTemplate("ops", { ...ARGS, key: "custom", title: "Custom" });
    for (const key of ["custom", "brand_new"]) {
      const err = await service
        .upsertOnboardingTemplate("ops", { ...ARGS, key, title: "Promoted", isCanonical: true })
        .catch((e: unknown) => e);
      expect(err).toMatchObject({ code: "ONBOARDING_TEMPLATE_CANONICAL", statusCode: 409 });
    }
    const page = await service.listOnboardingTemplates(undefined, 50);
    expect(page.items.map((t) => [t.key, t.title, t.isCanonical])).toEqual([
      ["custom", "Custom", false],
    ]);
  });
});
