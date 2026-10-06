// apps/backend/__tests__/engagement-scope.test.ts — GAP-093(a)/(d): the pure rules behind M3's
// `AuditorEngagementReader` (liveness + what an engagement's `scope` jsonb covers). Fail closed on anything
// malformed. The Drizzle read is proven in the live suite.
import { describe, expect, it } from "vitest";
import {
  ENROLLED_COUNT_KEY,
  isEngagementLive,
  parseEngagementCoverage,
  stripReservedScopeKeys,
} from "../src/modules/03-authorization/engagement-scope";

const ORG = "11111111-1111-4111-8111-111111111111";
const P1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const P2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const AT = new Date("2026-10-05T12:00:00Z");
const row = (over: Partial<Parameters<typeof isEngagementLive>[0]> = {}) => ({
  organizationId: ORG,
  status: "active",
  startAt: new Date("2026-10-01T00:00:00Z"),
  endAt: new Date("2026-10-15T00:00:00Z"),
  ...over,
});

describe("isEngagementLive", () => {
  it("is live for the same org, active status, inside the window", () => {
    expect(isEngagementLive(row(), ORG, AT)).toBe(true);
  });
  it("is not live for another org", () => {
    expect(isEngagementLive(row({ organizationId: "other" }), ORG, AT)).toBe(false);
  });
  it.each(["scheduled", "closed", "cancelled", "bogus", ""])(
    "is not live when status is %s",
    (s) => {
      expect(isEngagementLive(row({ status: s }), ORG, AT)).toBe(false);
    },
  );
  it("treats the window as [start, end): start inclusive, end exclusive", () => {
    expect(isEngagementLive(row(), ORG, new Date("2026-10-01T00:00:00Z"))).toBe(true);
    expect(isEngagementLive(row(), ORG, new Date("2026-09-30T23:59:59Z"))).toBe(false);
    expect(isEngagementLive(row(), ORG, new Date("2026-10-15T00:00:00Z"))).toBe(false);
  });
  it("fails closed on an invalid clock", () => {
    expect(isEngagementLive(row(), ORG, new Date("not a date"))).toBe(false);
  });
});

describe("parseEngagementCoverage", () => {
  it("reads an explicit patient list, de-duplicated, dropping malformed ids", () => {
    expect(parseEngagementCoverage({ patientIds: [P1, P2, P1, "nope", 7, null] })).toEqual({
      tenantWide: false,
      patientIds: [P1, P2],
    });
  });
  it("is tenant-wide only for an explicit boolean true", () => {
    expect(parseEngagementCoverage({ tenantWide: true }).tenantWide).toBe(true);
    for (const v of ["true", 1, "yes", null, {}, [true]]) {
      expect(parseEngagementCoverage({ tenantWide: v }).tenantWide).toBe(false);
    }
  });
  it("covers nothing for slices M3 cannot enumerate, and for malformed scope", () => {
    const empty = { tenantWide: false, patientIds: [] };
    expect(parseEngagementCoverage({ providerEntityIds: [P1], claimIds: [P2] })).toEqual(empty);
    for (const s of [null, undefined, "x", 5, [], { patientIds: "p" }]) {
      expect(parseEngagementCoverage(s)).toEqual(empty);
    }
  });
});

describe("stripReservedScopeKeys", () => {
  it("drops the server-owned enrolment counter a client tried to supply", () => {
    expect(stripReservedScopeKeys({ patientIds: [P1], [ENROLLED_COUNT_KEY]: 99 })).toEqual({
      patientIds: [P1],
    });
  });
  it("returns an empty scope for a non-object", () => {
    expect(stripReservedScopeKeys(null)).toEqual({});
    expect(stripReservedScopeKeys("x")).toEqual({});
  });
});
