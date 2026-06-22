// @wardenx/mdm — M40-T10 D7 eraser (§7.8) + cache key grammar (§4.8).
//
// Locks: the tenant-offboarding erase deletes overlay/provisional/baa rows and reports per-class
// counts (canonical never appears); re-running an erase is idempotent (0 the second time); and the
// §4.8 cache keys/prefixes/channels are exactly the documented grammar so the read + invalidation
// paths agree.
import { describe, expect, it } from "vitest";
import {
  asOfMinuteBucket,
  baaStatusKey,
  canonicalChangedChannel,
  canonicalKeyPrefix,
  createInMemoryMdmEraseStore,
  eraseTenantMdm,
  overlayChangedChannel,
  resolvedEntityKey,
} from "../src/index";

describe("eraseTenantMdm (§7.8 D7 tenant offboarding)", () => {
  it("deletes overlay/provisional/baa rows and reports per-class + total counts", async () => {
    const { store } = createInMemoryMdmEraseStore({
      overlaysByOrg: { org_a: 4 },
      provisionalsByOrg: { org_a: 2 },
      baaByOrg: { org_a: 3 },
    });
    const { erased, counts } = await eraseTenantMdm("org_a", store);
    expect(counts).toEqual({ overlays: 4, provisionals: 2, baaRecords: 3 });
    expect(erased).toBe(9);
  });

  it("an org with no MDM footprint erases to 0 (no-op offboarding)", async () => {
    const { store } = createInMemoryMdmEraseStore({ overlaysByOrg: { org_a: 5 } });
    const { erased } = await eraseTenantMdm("org_b", store);
    expect(erased).toBe(0);
  });

  it("is idempotent — a second erase of the same org removes nothing", async () => {
    const { store } = createInMemoryMdmEraseStore({
      overlaysByOrg: { org_a: 4 },
      baaByOrg: { org_a: 1 },
    });
    expect((await eraseTenantMdm("org_a", store)).erased).toBe(5);
    expect((await eraseTenantMdm("org_a", store)).erased).toBe(0);
  });
});

describe("cache key grammar (§4.8)", () => {
  it("resolved-entity key is mdm:<kind>:<id>:<orgId>", () => {
    expect(resolvedEntityKey("physician", "abc", "org_a")).toBe("mdm:physician:abc:org_a");
  });

  it("the canonical prefix drops every org's key for the entity", () => {
    const prefix = canonicalKeyPrefix("physician", "abc");
    expect(prefix).toBe("mdm:physician:abc:");
    // every org's resolved key starts with the canonical prefix → one sweep purges all of them.
    expect(resolvedEntityKey("physician", "abc", "org_a").startsWith(prefix)).toBe(true);
    expect(resolvedEntityKey("physician", "abc", "org_b").startsWith(prefix)).toBe(true);
  });

  it("invalidation channels follow the §4.8 grammar", () => {
    expect(canonicalChangedChannel("payer", "p1")).toBe("mdm.canonical_changed:payer:p1");
    expect(overlayChangedChannel("physician", "x", "org_a")).toBe(
      "mdm.overlay_changed:physician:x:org_a",
    );
  });

  it("BAA key buckets asOf to the minute so retries within 60s share a key", () => {
    const a = baaStatusKey("by_mdm", "org_a", "fac-1", new Date("2026-06-19T14:32:03Z"));
    const b = baaStatusKey("by_mdm", "org_a", "fac-1", new Date("2026-06-19T14:32:59Z"));
    expect(a).toBe(b); // same minute bucket
    expect(asOfMinuteBucket(new Date("2026-06-19T14:32:03Z"))).toBe("2026-06-19T14:32");
    const c = baaStatusKey("by_mdm", "org_a", "fac-1", new Date("2026-06-19T14:33:00Z"));
    expect(c).not.toBe(a); // next minute → distinct key
  });
});
