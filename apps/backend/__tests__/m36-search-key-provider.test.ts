// WP 2.7b / ADR-0058 P1+P2 wiring: the ring-backed SearchKeyProvider (fail closed, org isolation, no legacy fallback, lazy
// resolution), the global-search limiter factory (active only on a shared store) and source-level guards on index.ts.
import { createHmac, hkdfSync, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type RingBodyDek, deriveSearchKey } from "@chartwarden/messaging";
import { describe, expect, it, vi } from "vitest";
import { buildGlobalSearchRateLimit } from "../src/bootstrap/plugins/global-search-rate-limit";
import type { RateLimitStore } from "../src/bootstrap/plugins/rate-limit-store";
import type { RingDekCache } from "../src/modules/36-messaging/body-key-ring";
import {
  SearchKeyUnavailableError,
  createRingSearchKeyProvider,
} from "../src/modules/36-messaging/global-search/search-key-provider";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";

/** A fake ring: per-org, per-version DEKs; `active` names each org's current version. */
function fakeRing(active: Record<string, string> = { [ORG_A]: "v1", [ORG_B]: "v1" }) {
  const dek = (org: string, version: string): RingBodyDek => ({
    version,
    key: createHmac("sha256", "test-kek").update(`${org}:${version}`).digest(),
  });
  const fail: { error?: Error; destroyed: Set<string> } = { destroyed: new Set() };
  const guard = (org: string) => {
    if (fail.error) throw fail.error;
    if (fail.destroyed.has(org))
      throw Object.assign(new Error("ring destroyed"), { name: "TenantKeyDestroyed" });
  };
  const cache: RingDekCache = {
    current: async (org) => {
      guard(org);
      const v = active[org];
      if (!v) throw new Error("no ring");
      return dek(org, v);
    },
    byVersion: async (org, version) => {
      guard(org);
      return dek(org, version);
    },
    invalidate: () => undefined,
  };
  return { cache, fail, active, dek };
}

describe("ring-backed SearchKeyProvider", () => {
  it("derives K_search from the ring DEK for the named version (ADR-0058 decision 2)", async () => {
    const r = fakeRing();
    const keys = createRingSearchKeyProvider(() => r.cache);
    expect(await keys.activeVersion(ORG_A)).toBe("v1");
    expect(await keys.liveVersions(ORG_A)).toEqual(["v1"]);
    const k = await keys.tagKey(ORG_A, "v1");
    expect(k).toHaveLength(32);
    expect(k.equals(deriveSearchKey(r.dek(ORG_A, "v1").key, ORG_A, "v1"))).toBe(true);
  });

  it("org A's key never equals org B's, and the version label is stable across calls", async () => {
    const r = fakeRing();
    const keys = createRingSearchKeyProvider(() => r.cache);
    const a = await keys.tagKey(ORG_A, "v1");
    const b = await keys.tagKey(ORG_B, "v1");
    expect(a.equals(b)).toBe(false);
    expect((await keys.tagKey(ORG_A, "v1")).equals(a)).toBe(true);
    expect(await keys.activeVersion(ORG_A)).toBe(await keys.activeVersion(ORG_A));
  });

  it("rotation: the active version moves, the old version still derives, liveVersions is the active one only", async () => {
    const r = fakeRing();
    const keys = createRingSearchKeyProvider(() => r.cache);
    const v1 = await keys.tagKey(ORG_A, "v1");
    r.active[ORG_A] = "v2";
    expect(await keys.activeVersion(ORG_A)).toBe("v2");
    expect(await keys.liveVersions(ORG_A)).toEqual(["v2"]); // the ring cannot enumerate versions
    expect((await keys.tagKey(ORG_A, "v2")).equals(v1)).toBe(false);
    expect((await keys.tagKey(ORG_A, "v1")).equals(v1)).toBe(true);
  });

  it("fails closed with SearchKeyUnavailableError: unbound, destroyed, missing ring, outage, version mismatch", async () => {
    expect.assertions(8);
    const unbound = createRingSearchKeyProvider(() => undefined);
    await expect(unbound.activeVersion(ORG_A)).rejects.toBeInstanceOf(SearchKeyUnavailableError);
    await expect(unbound.tagKey(ORG_A, "v1")).rejects.toBeInstanceOf(SearchKeyUnavailableError);

    const r = fakeRing({ [ORG_A]: "v1" });
    const keys = createRingSearchKeyProvider(() => r.cache);
    r.fail.destroyed.add(ORG_A);
    await expect(keys.liveVersions(ORG_A)).rejects.toBeInstanceOf(SearchKeyUnavailableError);
    r.fail.destroyed.clear();
    await expect(keys.activeVersion(ORG_B)).rejects.toBeInstanceOf(SearchKeyUnavailableError);
    r.fail.error = new Error("kek vault down");
    await expect(keys.tagKey(ORG_A, "v1")).rejects.toBeInstanceOf(SearchKeyUnavailableError);
    r.fail.error = undefined;

    const lying: RingDekCache = {
      ...r.cache,
      byVersion: async () => ({ version: "v9", key: randomBytes(32) }),
    };
    const mismatched = createRingSearchKeyProvider(() => lying);
    await expect(mismatched.tagKey(ORG_A, "v1")).rejects.toBeInstanceOf(SearchKeyUnavailableError);
    const unversioned: RingDekCache = {
      ...r.cache,
      current: async () => ({ version: "", key: randomBytes(32) }),
    };
    await expect(
      createRingSearchKeyProvider(() => unversioned).activeVersion(ORG_A),
    ).rejects.toBeInstanceOf(SearchKeyUnavailableError);
    // The failure carries the cause but its message never repeats it.
    const err = await keys.activeVersion(ORG_B).catch((e: unknown) => e);
    expect((err as Error).message).not.toContain("no ring");
  });

  it("tagKeysForRead: [current, legacy] label order, keys equal an independent literal-label HKDF derivation", async () => {
    const r = fakeRing();
    const keys = createRingSearchKeyProvider(() => r.cache);
    const got = await keys.tagKeysForRead(ORG_A, "v1");
    const ring = r.dek(ORG_A, "v1").key;
    const hk = (ikm: Buffer, info: string) =>
      Buffer.from(hkdfSync("sha256", ikm, Buffer.alloc(0), info, 32));
    expect(got).toHaveLength(2);
    expect(got[0]?.labels.searchInfoPrefix).toBe("chartwarden-message-search:");
    expect(got[1]?.labels.searchInfoPrefix).toBe("wardenx-message-search:");
    expect(got[0]?.key.equals(hk(ring, `chartwarden-message-search:${ORG_A}:v1`))).toBe(true);
    expect(got[1]?.key.equals(hk(ring, `wardenx-message-search:${ORG_A}:v1`))).toBe(true);
    for (const entry of got) {
      expect(entry.key.equals(deriveSearchKey(ring, ORG_A, "v1", entry.labels))).toBe(true);
    }
  });

  it("tagKeysForRead fails closed: version mismatch, destroyed ring, outage, unbound", async () => {
    const r = fakeRing({ [ORG_A]: "v1" });
    const lying: RingDekCache = {
      ...r.cache,
      byVersion: async () => ({ version: "v9", key: randomBytes(32) }),
    };
    await expect(
      createRingSearchKeyProvider(() => lying).tagKeysForRead(ORG_A, "v1"),
    ).rejects.toBeInstanceOf(SearchKeyUnavailableError);
    const keys = createRingSearchKeyProvider(() => r.cache);
    r.fail.destroyed.add(ORG_A);
    await expect(keys.tagKeysForRead(ORG_A, "v1")).rejects.toBeInstanceOf(
      SearchKeyUnavailableError,
    );
    r.fail.destroyed.clear();
    r.fail.error = new Error("kek vault down");
    await expect(keys.tagKeysForRead(ORG_A, "v1")).rejects.toBeInstanceOf(
      SearchKeyUnavailableError,
    );
    await expect(
      createRingSearchKeyProvider(() => undefined).tagKeysForRead(ORG_A, "v1"),
    ).rejects.toBeInstanceOf(SearchKeyUnavailableError);
  });

  it("resolves the cache lazily: constructing the provider calls nothing", async () => {
    const getCache = vi.fn(() => undefined);
    const keys = createRingSearchKeyProvider(getCache);
    expect(getCache).not.toHaveBeenCalled();
    await keys.activeVersion(ORG_A).catch(() => undefined);
    expect(getCache).toHaveBeenCalledOnce();
  });
});

describe("global-search limiter wiring", () => {
  const store: RateLimitStore = { increment: async () => 1 } as unknown as RateLimitStore;

  it("is inactive and wires nothing without a shared (Valkey) store: the route keeps its fail-closed default", () => {
    expect(buildGlobalSearchRateLimit(undefined)).toEqual({ active: false });
  });

  it("is active only with a shared store, and then supplies the limiter", () => {
    const wiring = buildGlobalSearchRateLimit(store);
    expect(wiring.active).toBe(true);
    expect(typeof wiring.rateLimit).toBe("function");
  });

  it("an unauthenticated request is refused by the limiter (401), it never counts anonymous callers", async () => {
    const increment = vi.fn(async () => 1);
    const wiring = buildGlobalSearchRateLimit({ increment } as unknown as RateLimitStore);
    await expect(wiring.rateLimit?.({ context: {} } as never, {} as never)).rejects.toMatchObject({
      statusCode: 401,
    });
    expect(increment).not.toHaveBeenCalled();
  });
});

describe("wiring: index.ts", () => {
  const index = readFileSync(join(__dirname, "..", "src/index.ts"), "utf8");
  it("binds the ring provider lazily, the same provider to the indexer and the routes, and never the unavailable one", () => {
    expect(index).toContain("createRingSearchKeyProvider(() => sharedRingDekCache())");
    expect(index).not.toContain("createUnavailableSearchKeyProvider()");
    expect(index).toContain("keys: m36SearchKeys,");
    expect(index).toContain("globalSearchRateLimitActive: m36SearchRateLimit.active");
    expect(index).toContain("buildGlobalSearchRateLimit(rateLimitStore)");
  });
});
