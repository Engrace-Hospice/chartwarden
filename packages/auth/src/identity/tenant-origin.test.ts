// ADR-0049 D6 — one origin predicate behind Better Auth, the passkey ceremony, step-up and realtime.
import { describe, expect, it } from "vitest";
import { type TenantOriginResolver, createTenantOriginMatcher } from "./tenant-origin";

const BASE = "chartwarden.com";
const TABLE: Record<string, { status: string }> = {
  sunrise: { status: "active" },
  oldname: { status: "active" }, // a retired alias resolves like a slug
  fresh: { status: "created" },
  paused: { status: "suspended" },
  gone: { status: "closed" },
};
const resolver: TenantOriginResolver = { resolve: async (label) => TABLE[label] ?? null };
const matcher = createTenantOriginMatcher({ baseDomain: BASE, resolver });

describe("createTenantOriginMatcher", () => {
  it.each([
    "https://sunrise.chartwarden.com",
    "https://oldname.chartwarden.com",
    "https://fresh.chartwarden.com",
    "https://SUNRISE.chartwarden.com",
  ])("trusts %s", async (origin) => {
    expect(await matcher.isTrusted(origin)).toBe(true);
  });

  it.each([
    ["unknown slug", "https://nobody.chartwarden.com"],
    ["suspended", "https://paused.chartwarden.com"],
    ["closed", "https://gone.chartwarden.com"],
    ["http scheme", "http://sunrise.chartwarden.com"],
    ["explicit port", "https://sunrise.chartwarden.com:8443"],
    ["reserved admin host", "https://admin.chartwarden.com"],
    ["apex", "https://chartwarden.com"],
    ["multi-label", "https://a.sunrise.chartwarden.com"],
    ["suffix look-alike", "https://sunrise.chartwarden.com.evil.test"],
    ["prefix look-alike", "https://evilchartwarden.com"],
    ["userinfo", "https://sunrise.chartwarden.com@evil.test"],
    ["path", "https://sunrise.chartwarden.com/x"],
    ["not a url", "sunrise.chartwarden.com"],
    ["empty", ""],
  ])("does not trust %s", async (_name, origin) => {
    expect(await matcher.isTrusted(origin)).toBe(false);
  });

  it("trusts nothing in single-host mode (no base domain)", async () => {
    const off = createTenantOriginMatcher({ baseDomain: null, resolver });
    expect(await off.isTrusted("https://sunrise.chartwarden.com")).toBe(false);
  });
});
