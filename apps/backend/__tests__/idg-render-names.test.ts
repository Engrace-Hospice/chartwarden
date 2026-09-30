// M14 render-payload NAMES: the org-explicit site / membership lookups the packet-build worker makes (degrade,
// batching, names-only) and the per-patient render context that never names a Part 2-elided assignee.
import type { DbClient } from "@wardenx/db";
import type { PacketSnapshot } from "@wardenx/types";
import { describe, expect, it, vi } from "vitest";
import {
  SITE_DISPLAY_MAX_LOCATION_IDS,
  siteDisplayForOrg,
  toOrganizationDisplayName,
} from "../src/bootstrap/site-display-for-org";
import {
  buildPacketRenderContext,
  resolveMemberNames,
  resolvePacketSiteNames,
} from "../src/modules/14-idg/jobs/packet-render-context";

const warnings: Array<[string, Record<string, unknown>]> = [];
const warn = (e: string, c: Record<string, unknown>): void => {
  warnings.push([e, c]);
};

describe("toOrganizationDisplayName / siteDisplayForOrg guards", () => {
  it("prefers display_name, falls back to legal_name, else null (never an id)", () => {
    expect(toOrganizationDisplayName({ displayName: " Sunrise ", legalName: "Sunrise LLC" })).toBe(
      "Sunrise",
    );
    expect(toOrganizationDisplayName({ displayName: "  ", legalName: "Sunrise LLC" })).toBe(
      "Sunrise LLC",
    );
    expect(toOrganizationDisplayName({ displayName: null, legalName: null })).toBeNull();
  });
  it("refuses an oversized location list before touching the db", async () => {
    const exploding = new Proxy(
      {},
      {
        get: () => () => {
          throw new Error("db must not be touched");
        },
      },
    ) as unknown as DbClient;
    const many = Array.from({ length: SITE_DISPLAY_MAX_LOCATION_IDS + 1 }, (_, i) => `l${i}`);
    await expect(siteDisplayForOrg(exploding, "org", many)).rejects.toThrow(/exceeds the 100 cap/);
  });
});

describe("resolvePacketSiteNames", () => {
  it("ONE call with the meeting's location; maps to names", async () => {
    const port = {
      displayForSite: vi.fn(async () => ({
        organizationName: "Sunrise",
        locationNames: new Map([["loc", "North"]]),
      })),
    };
    expect(await resolvePacketSiteNames(port, "org", "loc", warn)).toEqual({
      organizationName: "Sunrise",
      locationName: "North",
    });
    expect(port.displayForSite).toHaveBeenCalledTimes(1);
    expect(port.displayForSite).toHaveBeenCalledWith("org", ["loc"]);
  });
  it("unbound => no names; a throwing port degrades to no names and warns without the error payload names", async () => {
    expect(await resolvePacketSiteNames(undefined, "org", "loc", warn)).toEqual({
      organizationName: null,
      locationName: null,
    });
    warnings.length = 0;
    const port = {
      displayForSite: async () => {
        throw new Error("boom");
      },
    };
    expect(await resolvePacketSiteNames(port, "org", "loc", warn)).toEqual({
      organizationName: null,
      locationName: null,
    });
    expect(warnings[0]?.[0]).toBe("m14.packet_build.site_display_unavailable");
  });
});

describe("resolveMemberNames", () => {
  it("de-duplicates, batches in ONE call, keeps names only, drops nameless", async () => {
    const port = {
      displayForMemberships: vi.fn(
        async () =>
          new Map([
            ["m1", { displayName: " Dana Reyes " }],
            ["m2", { displayName: null }],
          ]),
      ),
    };
    const out = await resolveMemberNames(port, "org", ["m1", "m1", "m2", "m3"], warn);
    expect(port.displayForMemberships).toHaveBeenCalledTimes(1);
    expect(port.displayForMemberships).toHaveBeenCalledWith("org", ["m1", "m2", "m3"]);
    expect([...out]).toEqual([["m1", "Dana Reyes"]]);
  });
  it("chunks at 500 ids", async () => {
    const port = { displayForMemberships: vi.fn(async () => new Map()) };
    await resolveMemberNames(
      port,
      "org",
      Array.from({ length: 1001 }, (_, i) => `m${i}`),
      warn,
    );
    expect(port.displayForMemberships).toHaveBeenCalledTimes(3);
  });
  it("unbound / empty / throwing => empty map, no throw", async () => {
    expect((await resolveMemberNames(undefined, "org", ["m1"], warn)).size).toBe(0);
    const never = { displayForMemberships: vi.fn(async () => new Map()) };
    expect((await resolveMemberNames(never, "org", [], warn)).size).toBe(0);
    expect(never.displayForMemberships).not.toHaveBeenCalled();
    const bad = {
      displayForMemberships: async () => {
        throw new Error("x");
      },
    };
    expect((await resolveMemberNames(bad, "org", ["m1"], warn)).size).toBe(0);
  });
});

describe("buildPacketRenderContext", () => {
  const snapshot = {
    carryForwardActionItems: [
      {
        actionItemId: "a1",
        assignedToMembershipId: "m1",
        dueDate: "2026-09-20T00:00:00.000Z",
        carryForwardCount: 1,
      },
    ],
  } as unknown as PacketSnapshot;
  const names = new Map([
    ["m1", "Dana Reyes"],
    ["mElided", "Sud Assignee"],
  ]);
  it("names only the assignees present in the (redacted) snapshot; header names ride `meeting`", () => {
    const ctx = buildPacketRenderContext(snapshot, {
      meetingId: "mtg",
      locationId: "loc",
      site: { organizationName: "Sunrise", locationName: "North" },
      names,
    });
    expect(ctx.memberNames).toEqual({ m1: "Dana Reyes" });
    expect(JSON.stringify(ctx)).not.toContain("Sud Assignee");
    expect(ctx.meeting).toEqual({
      meetingId: "mtg",
      locationId: "loc",
      organizationName: "Sunrise",
      locationName: "North",
    });
  });
  it("a Part 2-redacted snapshot (no carry-forward) carries no names at all; null site names are omitted", () => {
    const redacted = { carryForwardActionItems: [] } as unknown as PacketSnapshot;
    const ctx = buildPacketRenderContext(redacted, {
      meetingId: "mtg",
      locationId: "loc",
      site: { organizationName: null, locationName: null },
      names,
    });
    expect(ctx.memberNames).toEqual({});
    expect(ctx.meeting).toEqual({ meetingId: "mtg", locationId: "loc" });
  });
});
