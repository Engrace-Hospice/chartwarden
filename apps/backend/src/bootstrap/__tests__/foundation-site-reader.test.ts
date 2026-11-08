import type { DbClient } from "@chartwarden/db";
import { describe, expect, it } from "vitest";
import { buildFoundationSiteReader, soleDefaultLocation } from "../foundation-site-reader";

describe("soleDefaultLocation", () => {
  it("defaults to the only active location", () => {
    expect(soleDefaultLocation([{ id: "a", status: "active" }])).toBe("a");
  });

  it("does not pick between several active locations", () => {
    const rows = [
      { id: "ipu", status: "active" },
      { id: "main", status: "active" },
    ];
    expect(soleDefaultLocation(rows)).toBeNull();
  });

  it("falls back to a single created location when none is active", () => {
    expect(soleDefaultLocation([{ id: "c", status: "created" }])).toBe("c");
  });

  it("prefers the one active location over created ones", () => {
    const rows = [
      { id: "c", status: "created" },
      { id: "a", status: "active" },
    ];
    expect(soleDefaultLocation(rows)).toBe("a");
  });

  it("is null with no candidates", () => {
    expect(soleDefaultLocation([])).toBeNull();
  });
});

describe("Claim.MD internal site ownership reads", () => {
  it("returns only provider and location ownership facts from the caller's transaction", async () => {
    const selected: string[][] = [];
    const tx = {
      select(fields: Record<string, unknown>) {
        selected.push(Object.keys(fields));
        const rows =
          "organizationId" in fields
            ? [{ id: "synthetic-provider", organizationId: "synthetic-org" }]
            : [{ id: "synthetic-location", providerEntityId: "synthetic-provider" }];
        return {
          from() {
            return this;
          },
          where: async () => rows,
        };
      },
    } as unknown as DbClient;
    const reader = buildFoundationSiteReader();
    expect(await reader.providerEntityOwners(tx, ["synthetic-provider"])).toEqual([
      { id: "synthetic-provider", organizationId: "synthetic-org" },
    ]);
    expect(await reader.locationOwners(tx, ["synthetic-location"])).toEqual([
      { id: "synthetic-location", providerEntityId: "synthetic-provider" },
    ]);
    expect(selected).toEqual([
      ["id", "organizationId"],
      ["id", "providerEntityId"],
    ]);
    expect(await reader.providerEntityOwners(tx, [])).toEqual([]);
    expect(await reader.locationOwners(tx, [])).toEqual([]);
    expect(selected).toHaveLength(2);
  });
});
