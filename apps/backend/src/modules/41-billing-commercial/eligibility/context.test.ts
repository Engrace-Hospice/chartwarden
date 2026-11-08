import { describe, expect, it } from "vitest";
import { buildCommercialContextPort } from "./context";

const ORG_TENANT = "00000000-0000-4000-8000-000000000051";
const ORG_PLATFORM = "00000000-0000-4000-8000-000000000052";
const PE = "00000000-0000-4000-8000-0000000000e1";

// The platform usage is `test` (a non-production NODE_ENV with CLEARINGHOUSE_USAGE unset); `usageFor` speaks for ONE organization.
const PLATFORM_CONFIG = { NODE_ENV: "development" } as const;
const NPI = async () => "1234567893";

describe("buildCommercialContextPort usage", () => {
  it("keeps the platform usage when no per-organization usage is supplied", async () => {
    const port = buildCommercialContextPort({ env: PLATFORM_CONFIG, providerNpi: NPI });

    const ctx = await port.contextFor(ORG_PLATFORM, PE, "CH-PAYER-1");

    expect(ctx?.usage).toBe("test");
  });

  it("uses the organization's own usage for that organization only", async () => {
    const port = buildCommercialContextPort({
      env: PLATFORM_CONFIG,
      providerNpi: NPI,
      usageFor: async (organizationId) => (organizationId === ORG_TENANT ? "production" : null),
    });

    const tenant = await port.contextFor(ORG_TENANT, PE, "CH-PAYER-1");
    const other = await port.contextFor(ORG_PLATFORM, PE, "CH-PAYER-1");

    expect(tenant?.usage).toBe("production");
    expect(other?.usage).toBe("test");
  });

  it("still answers null when the provider entity has no NPI, whatever the usage", async () => {
    const port = buildCommercialContextPort({
      env: PLATFORM_CONFIG,
      providerNpi: async () => null,
      usageFor: async () => "production",
    });

    expect(await port.contextFor(ORG_TENANT, PE, "CH-PAYER-1")).toBeNull();
  });
});
