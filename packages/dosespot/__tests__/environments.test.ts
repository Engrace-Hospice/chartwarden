// Slice 4 — a tenant never supplies a DoseSpot URL: the `environment` it picks maps to a platform-held https host, so a
// registration can never aim the clinic key (or PHI) at an arbitrary server.
import { describe, expect, it } from "vitest";
import {
  DOSESPOT_SANDBOX_DEFAULT_BASE_URL,
  resolveDoseSpotEnvironment,
  subscriptionKeyFallback,
} from "../src";

describe("DoseSpot environment resolution", () => {
  it("maps sandbox to the staging host by default and drops a trailing slash", () => {
    expect(resolveDoseSpotEnvironment("sandbox", {})).toEqual({
      ok: true,
      baseUrl: DOSESPOT_SANDBOX_DEFAULT_BASE_URL,
    });
    expect(
      resolveDoseSpotEnvironment("sandbox", {
        DOSESPOT_BASE_URL_SANDBOX: "https://my.staging.dosespot.com/webapi/v2/",
      }),
    ).toEqual({ ok: true, baseUrl: "https://my.staging.dosespot.com/webapi/v2" });
  });

  it("has no baked-in production host: production needs the flag and an explicit URL", () => {
    expect(resolveDoseSpotEnvironment("production", {})).toEqual({
      ok: false,
      reason: "production_disabled",
    });
    expect(
      resolveDoseSpotEnvironment("production", { DOSESPOT_PRODUCTION_ENABLED: "true" }),
    ).toEqual({ ok: false, reason: "production_url_unset" });
    expect(
      resolveDoseSpotEnvironment("production", {
        DOSESPOT_PRODUCTION_ENABLED: "true",
        DOSESPOT_BASE_URL_PRODUCTION: "https://my.dosespot.com/webapi/v2",
      }),
    ).toEqual({ ok: true, baseUrl: "https://my.dosespot.com/webapi/v2" });
  });

  it("only an exact 'true' enables production", () => {
    for (const flag of ["TRUE", "1", "yes", " true", ""]) {
      const r = resolveDoseSpotEnvironment("production", {
        DOSESPOT_PRODUCTION_ENABLED: flag,
        DOSESPOT_BASE_URL_PRODUCTION: "https://my.dosespot.com/webapi/v2",
      });
      expect(r).toEqual({ ok: false, reason: "production_disabled" });
    }
  });

  it("refuses an override that is not https or not a dosespot.com host", () => {
    for (const bad of [
      "http://my.staging.dosespot.com/webapi/v2",
      "https://evil.example.com/webapi/v2",
      "https://dosespot.com.evil.example/webapi/v2",
      "https://127.0.0.1/webapi/v2",
      "https://user:pass@my.staging.dosespot.com/webapi/v2",
      "not a url",
    ]) {
      expect(resolveDoseSpotEnvironment("sandbox", { DOSESPOT_BASE_URL_SANDBOX: bad })).toEqual({
        ok: false,
        reason: "base_url_invalid",
      });
    }
  });

  it("reads the platform subscription-key fallback per environment, empty when unset", () => {
    expect(subscriptionKeyFallback("sandbox", { DOSESPOT_SUBSCRIPTION_KEY_SANDBOX: "k-s" })).toBe(
      "k-s",
    );
    expect(
      subscriptionKeyFallback("production", { DOSESPOT_SUBSCRIPTION_KEY_PRODUCTION: "k-p" }),
    ).toBe("k-p");
    expect(
      subscriptionKeyFallback("sandbox", { DOSESPOT_SUBSCRIPTION_KEY_SANDBOX: "  " }),
    ).toBeNull();
    expect(subscriptionKeyFallback("sandbox", {})).toBeNull();
  });
});
