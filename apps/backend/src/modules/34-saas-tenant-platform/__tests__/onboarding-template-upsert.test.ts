// The onboarding-template catalog's upsert (in-memory twin): a canonical template is migration-owned and never overwritten.
import { ChartWardenError } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import { createInMemoryTenantPlatformBackend } from "../routes/platform/service";

const ARGS = { title: "Renamed", description: null, canonicalOrder: 9, isCanonical: false };

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
});
