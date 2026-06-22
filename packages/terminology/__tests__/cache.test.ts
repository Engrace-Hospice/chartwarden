// M38-T10 — the §4.6 cache key grammar + invalidation + the in-memory cache port.
//
// Accept: the four cache keys follow the documented grammar; a version load purges the system's
// lookup + search caches by prefix while leaving other systems intact; a tenant extension key is
// purged by exact key; the query-opts hash is deterministic across runs (no clock/RNG).
import { describe, expect, it } from "vitest";
import {
  TERMINOLOGY_CACHE_TTL_SECONDS,
  createInMemoryTerminologyCache,
  hashQueryOpts,
  lookupKey,
  lookupSystemPrefix,
  searchKey,
  searchSystemPrefix,
  tenantExtensionKey,
  valueSetMembershipKey,
  valueSetPrefix,
  versionLoadInvalidationPrefixes,
} from "../src/cache/index";

describe("M38-T10 cache keys — the §4.6 grammar", () => {
  it("builds each cache key per spec", () => {
    expect(lookupKey("icd10cm", "I50.21", "2024-08-01")).toBe(
      "term:lookup:icd10cm:I50.21:2024-08-01",
    );
    expect(
      valueSetMembershipKey("hospice_terminal_diagnosis", "icd10cm", "G30.9", "2024-08-01"),
    ).toBe("term:vs:hospice_terminal_diagnosis:icd10cm:G30.9:2024-08-01");
    expect(searchKey("icd10cm", "fuzzy", "deadbeef", "2024-08-01")).toBe(
      "term:search:icd10cm:fuzzy:deadbeef:2024-08-01",
    );
    expect(tenantExtensionKey("org_1", "level_of_care")).toBe("term:vsext:org_1:level_of_care");
  });

  it("the lookup/search prefixes are key prefixes (purgeable en masse)", () => {
    expect(
      lookupKey("icd10cm", "I50.21", "2024-08-01").startsWith(lookupSystemPrefix("icd10cm")),
    ).toBe(true);
    expect(
      searchKey("icd10cm", "fuzzy", "x", "2024-08-01").startsWith(searchSystemPrefix("icd10cm")),
    ).toBe(true);
    expect(
      valueSetMembershipKey("vs1", "icd10cm", "X", "2024-08-01").startsWith(valueSetPrefix("vs1")),
    ).toBe(true);
  });

  it("declares the §4.6 TTLs (lookup/membership 1h, search 15m, tenant extension 5m)", () => {
    expect(TERMINOLOGY_CACHE_TTL_SECONDS).toEqual({
      lookup: 3600,
      valueSet: 3600,
      search: 900,
      tenantExtension: 300,
    });
  });

  it("hashes query+opts deterministically and distinctly", () => {
    expect(hashQueryOpts("chf", { mode: "fuzzy" })).toBe(hashQueryOpts("chf", { mode: "fuzzy" }));
    expect(hashQueryOpts("chf", { mode: "fuzzy" })).not.toBe(
      hashQueryOpts("chf", { mode: "exact" }),
    );
    // Option order does not change the hash (canonicalised).
    expect(hashQueryOpts("chf", { mode: "fuzzy", limit: 10 })).toBe(
      hashQueryOpts("chf", { limit: 10, mode: "fuzzy" }),
    );
  });
});

describe("M38-T10 cache invalidation — in-memory port", () => {
  it("a version load purges the loaded system's lookup+search caches, leaving others intact", async () => {
    const { cache, size } = createInMemoryTerminologyCache();
    await cache.set(
      lookupKey("icd10cm", "I50.21", "2024-08-01"),
      "{}",
      TERMINOLOGY_CACHE_TTL_SECONDS.lookup,
    );
    await cache.set(
      searchKey("icd10cm", "fuzzy", "h", "2024-08-01"),
      "[]",
      TERMINOLOGY_CACHE_TTL_SECONDS.search,
    );
    await cache.set(
      lookupKey("snomed", "73211009", "2024-08-01"),
      "{}",
      TERMINOLOGY_CACHE_TTL_SECONDS.lookup,
    );
    expect(size()).toBe(3);

    let deleted = 0;
    for (const prefix of versionLoadInvalidationPrefixes("icd10cm")) {
      deleted += (await cache.deletePrefix(prefix)).deleted;
    }
    expect(deleted).toBe(2); // both icd10cm keys
    expect(await cache.get(lookupKey("snomed", "73211009", "2024-08-01"))).toBe("{}"); // snomed survives
    expect(await cache.get(lookupKey("icd10cm", "I50.21", "2024-08-01"))).toBeNull();
  });

  it("a tenant extension change purges that org's value-set extension key only", async () => {
    const { cache } = createInMemoryTerminologyCache();
    await cache.set(
      tenantExtensionKey("org_1", "level_of_care"),
      "[]",
      TERMINOLOGY_CACHE_TTL_SECONDS.tenantExtension,
    );
    await cache.set(
      tenantExtensionKey("org_2", "level_of_care"),
      "[]",
      TERMINOLOGY_CACHE_TTL_SECONDS.tenantExtension,
    );
    await cache.delete(tenantExtensionKey("org_1", "level_of_care"));
    expect(await cache.get(tenantExtensionKey("org_1", "level_of_care"))).toBeNull();
    expect(await cache.get(tenantExtensionKey("org_2", "level_of_care"))).toBe("[]");
  });
});
