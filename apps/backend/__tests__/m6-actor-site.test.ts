import { describe, expect, it } from "vitest";
import { soleSiteOf } from "../src/modules/06-admission/actor-site";

describe("soleSiteOf — the site stamped on a patient created from a referral", () => {
  it("stamps a single provider entity with its single location", () => {
    expect(soleSiteOf({ providerEntityIds: ["pe"], locationIds: ["loc"] })).toEqual({
      providerEntityId: "pe",
      locationId: "loc",
    });
  });

  it("stamps the entity alone when the actor has no or several locations", () => {
    expect(soleSiteOf({ providerEntityIds: ["pe"], locationIds: [] })?.locationId).toBeNull();
    expect(
      soleSiteOf({ providerEntityIds: ["pe"], locationIds: ["a", "b"] })?.locationId,
    ).toBeNull();
  });

  it("leaves the patient unsited for an org-wide actor or an actor with several entities", () => {
    expect(soleSiteOf({ providerEntityIds: [], locationIds: [] })).toBeNull();
    expect(soleSiteOf({ providerEntityIds: [], locationIds: ["loc"] })).toBeNull();
    expect(soleSiteOf({ providerEntityIds: ["a", "b"], locationIds: ["loc"] })).toBeNull();
  });
});
