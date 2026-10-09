/**
 * GAP-007 - the pure rules for membership_role.scope: parsing, grant-time validation and the effective reach
 * reduced from live grants. The route (422) and the DB actor-enrichment reader are proven separately.
 */
import { describe, expect, it } from "vitest";
import { effectiveReach, parseRoleGrantScope, validateRoleGrant } from "../src";

const LOC_X = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const LOC_Y = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const LOC_Z = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3";
const PE_1 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const NONE = { providerEntityIds: [], locationIds: [] };
const NOW = new Date("2026-10-08T12:00:00Z");

describe("parseRoleGrantScope", () => {
  it("treats null, undefined and {} as no narrowing", () => {
    for (const raw of [null, undefined, {}])
      expect(parseRoleGrantScope(raw)).toEqual({ ok: true, scope: {} });
  });
  it("refuses unknown keys, non-uuids, empty lists and non-objects", () => {
    for (const raw of [{ floor: 1 }, { locationIds: ["x"] }, { locationIds: [] }, [], "x"])
      expect(parseRoleGrantScope(raw).ok).toBe(false);
  });
  it("de-duplicates ids", () => {
    expect(parseRoleGrantScope({ locationIds: [LOC_X, LOC_X] })).toEqual({
      ok: true,
      scope: { locationIds: [LOC_X] },
    });
  });
});

describe("validateRoleGrant", () => {
  const grant = (over: Partial<Parameters<typeof validateRoleGrant>[0]> = {}) =>
    validateRoleGrant({
      role: { scopeLevel: "organization", category: "operations" },
      scope: undefined,
      membership: NONE,
      expiresAt: null,
      now: NOW,
      ...over,
    }).map((v) => v.code);

  it("accepts an unscoped organization role", () => expect(grant()).toEqual([]));
  it("refuses a location role org-wide, accepts it with location ids or default locations", () => {
    const role = { scopeLevel: "location", category: "operations" };
    expect(grant({ role })).toEqual(["ROLE_REQUIRES_NARROWING"]);
    expect(grant({ role, scope: { locationIds: [LOC_X] } })).toEqual([]);
    expect(grant({ role, membership: { providerEntityIds: [], locationIds: [LOC_X] } })).toEqual(
      [],
    );
  });
  it("refuses provider-entity ids on a location role (wider than its level)", () => {
    expect(
      grant({
        role: { scopeLevel: "location", category: "operations" },
        scope: { locationIds: [LOC_X], providerEntityIds: [PE_1] },
      }),
    ).toContain("SCOPE_WIDER_THAN_ROLE");
  });
  it("refuses ids outside a set membership reach", () => {
    expect(
      grant({
        scope: { locationIds: [LOC_Z] },
        membership: { providerEntityIds: [], locationIds: [LOC_X, LOC_Y] },
      }),
    ).toEqual(["SCOPE_OUTSIDE_MEMBERSHIP"]);
  });
  it("requires a future expiry for a time-bound role, and refuses any past one", () => {
    const locum = { scopeLevel: "organization", category: "temporary_special" };
    expect(grant({ role: locum })).toEqual(["EXPIRY_REQUIRED"]);
    expect(grant({ role: locum, expiresAt: new Date("2026-11-01T00:00:00Z") })).toEqual([]);
    expect(grant({ expiresAt: new Date("2026-01-01T00:00:00Z") })).toEqual(["EXPIRY_NOT_FUTURE"]);
  });
  it("never lets a patient-scoped role be granted to a membership", () => {
    expect(grant({ role: { scopeLevel: "patient", category: "operations" } })).toContain(
      "ROLE_NOT_ASSIGNABLE",
    );
  });
});

describe("effectiveReach", () => {
  const defaults = { providerEntityIds: [PE_1], locationIds: [LOC_X, LOC_Y] };
  it("is the defaults for unscoped grants and for no grants", () => {
    expect(effectiveReach(defaults, [])).toEqual(defaults);
    expect(effectiveReach(defaults, [{ scope: {} }, { scope: null }])).toEqual(defaults);
  });
  it("narrows to the scoped location when every role is scoped to it", () => {
    expect(effectiveReach(defaults, [{ scope: { locationIds: [LOC_X] } }])).toEqual({
      providerEntityIds: [PE_1],
      locationIds: [LOC_X],
    });
  });
  it("one unscoped role restores the defaults (a grant can only narrow its own role)", () => {
    expect(
      effectiveReach(defaults, [{ scope: { locationIds: [LOC_X] } }, { scope: {} }]).locationIds,
    ).toEqual([LOC_X, LOC_Y]);
  });
  it("is the union across scoped roles and never wider than the membership defaults", () => {
    const reach = effectiveReach(defaults, [
      { scope: { locationIds: [LOC_X] } },
      { scope: { locationIds: [LOC_Y, LOC_Z] } },
    ]);
    expect([...reach.locationIds].sort()).toEqual([LOC_X, LOC_Y]);
  });
  it("a malformed stored scope reads as no narrowing, never as wider reach", () => {
    expect(effectiveReach(defaults, [{ scope: { locationIds: "bad" } }]).locationIds).toEqual([
      LOC_X,
      LOC_Y,
    ]);
  });
});
