import { describe, expect, it } from "vitest";
import { createTenantAppOrigin } from "../tenant-app-origin";

const ORG = "00000000-0000-4000-8000-000000000001";
const base = {
  fallbackOrigin: "https://demo.chartwarden.cloud/",
  portalOverride: "https://portal.chartwarden.cloud",
  slugForOrg: async () => "acme" as string | null,
};

describe("tenantAppOrigin", () => {
  it("uses the organization's subdomain and /portal path when a base domain is set", async () => {
    const o = createTenantAppOrigin({ ...base, baseDomain: "chartwarden.com" });
    expect(await o.appOrigin(ORG)).toBe("https://acme.chartwarden.com");
    expect(await o.portalOrigin(ORG)).toBe("https://acme.chartwarden.com/portal");
  });

  it("keeps today's global origins when no base domain is set (PORTAL_APP_URL still overrides portal)", async () => {
    const o = createTenantAppOrigin({ ...base, baseDomain: null });
    expect(await o.appOrigin(ORG)).toBe("https://demo.chartwarden.cloud");
    expect(await o.portalOrigin(ORG)).toBe("https://portal.chartwarden.cloud");
  });

  it("falls back to the global origin, ignoring PORTAL_APP_URL, when the slug is unknown or the lookup fails", async () => {
    const unknown = createTenantAppOrigin({ ...base, baseDomain: "chartwarden.com", slugForOrg: async () => null });
    expect(await unknown.appOrigin(ORG)).toBe("https://demo.chartwarden.cloud");
    expect(await unknown.portalOrigin(ORG)).toBe("https://demo.chartwarden.cloud");
    const failing = createTenantAppOrigin({
      ...base,
      baseDomain: "chartwarden.com",
      slugForOrg: async () => {
        throw new Error("db down");
      },
    });
    expect(await failing.appOrigin(ORG)).toBe("https://demo.chartwarden.cloud");
  });

  it("returns undefined when nothing is configured", async () => {
    const o = createTenantAppOrigin({ baseDomain: null, fallbackOrigin: undefined, slugForOrg: async () => null });
    expect(await o.appOrigin(ORG)).toBeUndefined();
  });
});
