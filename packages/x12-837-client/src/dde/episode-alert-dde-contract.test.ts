// Vendor qualification is intentionally unavailable: there is no verified API wire, approved destination, or confirmed
// isolated sandbox. Environment variables and trial credentials cannot enable this suite. A future qualification lot
// must replace this static skip only after vendor documentation and a safe test environment are recorded.
import { describe, expect, it } from "vitest";
import { createEpisodeAlertDdeProviderFromEnv } from "./episode-alert-dde-provider";
import { EA_DDE_FACTS, EA_DDE_WIRE } from "./episode-alert-dde-wire";

describe.skip("Episode Alert DDE vendor contract (blocked: wire and sandbox unverified)", () => {
  it("requires a reviewed vendor contract, approved destination, and separately authorized sandbox", () => {
    // Deliberately not executable based on environment credentials or operator attestations.
  });
});

describe("Episode Alert DDE qualification readiness", () => {
  it("keeps the vendor contract unverified and blocks environment binding", () => {
    expect(EA_DDE_WIRE.verified).toBe(false);
    expect(Object.values(EA_DDE_FACTS).every((value) => value === null)).toBe(true);
    expect(() => createEpisodeAlertDdeProviderFromEnv({})).toThrow(
      /wire format and approved API destination are unverified/,
    );
  });
});
