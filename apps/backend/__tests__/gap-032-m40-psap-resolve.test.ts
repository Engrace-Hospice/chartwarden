// GAP-032 - the pure PSAP resolution rule (no database).
import { describe, expect, it } from "vitest";

import {
  type JurisdictionRowFacts,
  isStale,
  resolveJurisdiction,
} from "../src/modules/40-mdm/psap-resolve";

const NOW = new Date("2026-10-08T12:00:00.000Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);

const square = (w: number, s: number, e: number, n: number) =>
  [
    [
      [w, s],
      [e, s],
      [e, n],
      [w, n],
      [w, s],
    ],
  ] as const;

const row = (over: Partial<JurisdictionRowFacts> & { id: string }): JurisdictionRowFacts => ({
  name: `J-${over.id}`,
  psapName: "PSAP",
  psapPhone: "+15035550101",
  secondaryPhone: null,
  polygon: null,
  appliesToLocationId: null,
  isOrgDefault: false,
  verifiedAt: daysAgo(10),
  verifyEveryDays: 180,
  ...over,
});

const STATE = row({ id: "a-state", polygon: square(-125, 42, -116, 46.5) });
const COUNTY = row({ id: "b-county", polygon: square(-123, 45, -122, 46) });
const LOC = row({ id: "c-loc", appliesToLocationId: "loc-1" });
const ORG = row({ id: "d-org", isOrgDefault: true });
const POINT = { latitude: 45.5, longitude: -122.5 };

describe("resolveJurisdiction", () => {
  it("prefers the smallest drawn polygon containing the point", () => {
    expect(
      resolveJurisdiction([STATE, COUNTY, LOC, ORG], { point: POINT, locationId: "loc-1" }, NOW),
    ).toMatchObject({
      kind: "resolved",
      jurisdictionId: "b-county",
      confidence: "point_in_polygon",
    });
  });

  it("falls back to the location default, then the org default, then none", () => {
    expect(
      resolveJurisdiction(
        [STATE, LOC, ORG],
        { point: { latitude: 10, longitude: 10 }, locationId: "loc-1" },
        NOW,
      ),
    ).toMatchObject({
      jurisdictionId: "c-loc",
      confidence: "location_default",
    });
    expect(
      resolveJurisdiction([LOC, ORG], { point: null, locationId: "loc-OTHER" }, NOW),
    ).toMatchObject({
      jurisdictionId: "d-org",
      confidence: "org_default",
    });
    expect(resolveJurisdiction([LOC], { point: null, locationId: "loc-OTHER" }, NOW)).toEqual({
      kind: "none",
    });
    expect(resolveJurisdiction([], { point: POINT, locationId: null }, NOW)).toEqual({
      kind: "none",
    });
  });

  it("is deterministic on equal polygons (lowest id wins)", () => {
    const a = row({ id: "z", polygon: square(-123, 45, -122, 46) });
    const b = row({ id: "m", polygon: square(-123, 45, -122, 46) });
    expect(resolveJurisdiction([a, b], { point: POINT, locationId: null }, NOW)).toMatchObject({
      jurisdictionId: "m",
    });
    expect(resolveJurisdiction([b, a], { point: POINT, locationId: null }, NOW)).toMatchObject({
      jurisdictionId: "m",
    });
  });

  it("flags a stale row but still returns it", () => {
    const old = row({ id: "o", isOrgDefault: true, verifiedAt: daysAgo(181) });
    expect(isStale(old, NOW)).toBe(true);
    expect(resolveJurisdiction([old], { point: null, locationId: null }, NOW)).toMatchObject({
      kind: "resolved",
      stale: true,
    });
    expect(isStale(row({ id: "f", isOrgDefault: true, verifiedAt: daysAgo(179) }), NOW)).toBe(
      false,
    );
  });

  it("ignores a polygon when there is no point", () => {
    expect(resolveJurisdiction([COUNTY], { point: null, locationId: null }, NOW)).toEqual({
      kind: "none",
    });
  });
});
