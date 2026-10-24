// M36 WP 2.13 / ADR-0058 P1 — the body cipher over the M34 ring: scheme selection, both-scheme read, cache.
import { randomBytes } from "node:crypto";
import { bodyEnvelopeScheme, ringEnvelopeVersion } from "@chartwarden/messaging";
import { describe, expect, it } from "vitest";
import {
  type MessageBodyKeyProvider,
  createRingDekCache,
} from "../src/modules/36-messaging/body-key-ring";
import {
  bodySealSchemeFromEnv,
  createMessageBodyCipher,
} from "../src/modules/36-messaging/messaging-write-core";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const KEK = randomBytes(32);

/** A fake M34 provider: per-org version → key, a current pointer, a destroyed set, and call counters. */
function fakeRing() {
  const keys = new Map<string, Map<string, Buffer>>();
  const current = new Map<string, string>();
  const destroyed = new Set<string>();
  const calls = { current: 0, version: 0 };
  const provider: MessageBodyKeyProvider = {
    async dekForOrg(orgId) {
      calls.current += 1;
      if (destroyed.has(orgId)) throw new Error("TenantKeyDestroyed");
      const v = current.get(orgId);
      const key = v ? keys.get(orgId)?.get(v) : undefined;
      if (!v || !key) throw new Error("TenantKeyMissing");
      return { version: v, key };
    },
    async dekForOrgVersion(orgId, version) {
      calls.version += 1;
      if (destroyed.has(orgId)) throw new Error("TenantKeyDestroyed");
      const key = keys.get(orgId)?.get(version);
      if (!key) throw new Error("TenantKeyVersionMissing");
      return { version, key };
    },
  };
  return {
    provider,
    calls,
    destroyed,
    mint(orgId: string, version: string) {
      const m = keys.get(orgId) ?? new Map<string, Buffer>();
      m.set(version, randomBytes(32));
      keys.set(orgId, m);
      current.set(orgId, version);
    },
  };
}

describe("ring DEK cache", () => {
  it("serves repeat lookups from memory and dedupes concurrent ones", async () => {
    const ring = fakeRing();
    ring.mint(ORG_A, "v1");
    const cache = createRingDekCache(ring.provider);
    await Promise.all([cache.current(ORG_A), cache.current(ORG_A), cache.current(ORG_A)]);
    await cache.current(ORG_A);
    await cache.byVersion(ORG_A, "v1");
    await cache.byVersion(ORG_A, "v1");
    expect(ring.calls).toEqual({ current: 1, version: 1 });
  });

  it("refetches after the TTL", async () => {
    const ring = fakeRing();
    ring.mint(ORG_A, "v1");
    let t = 1_000;
    const cache = createRingDekCache(ring.provider, { ttlMs: 100, now: () => t });
    await cache.current(ORG_A);
    t += 99;
    await cache.current(ORG_A);
    expect(ring.calls.current).toBe(1);
    t += 2;
    await cache.current(ORG_A);
    expect(ring.calls.current).toBe(2);
  });

  it("invalidate(org) drops that org only; a destroyed ring is never memoised", async () => {
    const ring = fakeRing();
    ring.mint(ORG_A, "v1");
    ring.mint(ORG_B, "v1");
    const cache = createRingDekCache(ring.provider);
    await cache.current(ORG_A);
    await cache.current(ORG_B);
    cache.invalidate(ORG_A);
    await cache.current(ORG_A);
    await cache.current(ORG_B);
    expect(ring.calls.current).toBe(3);

    ring.destroyed.add(ORG_A);
    cache.invalidate(ORG_A);
    await expect(cache.current(ORG_A)).rejects.toThrow(/Destroyed/);
    await expect(cache.current(ORG_A)).rejects.toThrow(/Destroyed/);
    expect(ring.calls.current).toBe(5); // each failure asked the provider again
  });
});

describe("MESSAGING seal scheme selection", () => {
  it("defaults to legacy, accepts ring, rejects anything else (no silent downgrade on a typo)", () => {
    expect(bodySealSchemeFromEnv({})).toBe("legacy");
    expect(bodySealSchemeFromEnv({ M36_BODY_SEAL_SCHEME: "ring" })).toBe("ring");
    expect(bodySealSchemeFromEnv({ M36_BODY_SEAL_SCHEME: " Legacy " })).toBe("legacy");
    expect(() => bodySealSchemeFromEnv({ M36_BODY_SEAL_SCHEME: "rign" })).toThrow(/legacy/);
  });
});

describe("message body cipher over the ring", () => {
  it("seals under the configured scheme and records it in the envelope", async () => {
    const ring = fakeRing();
    ring.mint(ORG_A, "v1");
    const legacy = createMessageBodyCipher({ kek: KEK, keys: ring.provider, sealScheme: "legacy" });
    const viaRing = createMessageBodyCipher({ kek: KEK, keys: ring.provider, sealScheme: "ring" });
    const l = await legacy.seal(ORG_A, "hello");
    const r = await viaRing.seal(ORG_A, "hello");
    expect(bodyEnvelopeScheme(l.cipher)).toBe("legacy");
    expect(bodyEnvelopeScheme(r.cipher)).toBe("ring");
    expect(ringEnvelopeVersion(r.cipher)).toBe("v1");
    expect(l.sha256).toBe(r.sha256); // body_sha256 is of the plaintext: scheme-independent
    expect((await legacy.sealRing(ORG_A, "hello")).cipher[0]).toBe(2);
  });

  it("opens BOTH schemes with one cipher, whatever the write scheme", async () => {
    const ring = fakeRing();
    ring.mint(ORG_A, "v1");
    const c = createMessageBodyCipher({ kek: KEK, keys: ring.provider, sealScheme: "ring" });
    const legacyRow = (
      await createMessageBodyCipher({ kek: KEK, sealScheme: "legacy" }).seal(ORG_A, "old row")
    ).cipher;
    const ringRow = (await c.seal(ORG_A, "new row")).cipher;
    expect(await c.open(ORG_A, legacyRow)).toBe("old row");
    expect(await c.open(ORG_A, ringRow)).toBe("new row");
  });

  it("a ring row opens with no MESSAGING_ENCRYPTION_KEY at all; a legacy row then fails closed", async () => {
    const ring = fakeRing();
    ring.mint(ORG_A, "v1");
    const noKek = createMessageBodyCipher({ keys: ring.provider, sealScheme: "ring" });
    const sealed = await noKek.seal(ORG_A, "ring only");
    expect(await noKek.open(ORG_A, sealed.cipher)).toBe("ring only");
    const legacyRow = (
      await createMessageBodyCipher({ kek: KEK, sealScheme: "legacy" }).seal(ORG_A, "x")
    ).cipher;
    const saved = process.env.MESSAGING_ENCRYPTION_KEY;
    // biome-ignore lint/performance/noDelete: an env var must be unset, not the string "undefined".
    delete process.env.MESSAGING_ENCRYPTION_KEY;
    try {
      await expect(noKek.open(ORG_A, legacyRow)).rejects.toThrow(
        /Message encryption is unavailable/,
      );
    } finally {
      if (saved !== undefined) process.env.MESSAGING_ENCRYPTION_KEY = saved;
    }
  });

  it("an org cannot open another org's ring body (separate DEKs and AAD)", async () => {
    const ring = fakeRing();
    ring.mint(ORG_A, "v1");
    ring.mint(ORG_B, "v1");
    const c = createMessageBodyCipher({ keys: ring.provider, sealScheme: "ring" });
    const { cipher } = await c.seal(ORG_A, "A's secret");
    await expect(c.open(ORG_B, cipher)).rejects.toThrow();
  });

  it("rotation: old rows still open by their recorded version, new writes use the new one", async () => {
    const ring = fakeRing();
    ring.mint(ORG_A, "v1");
    const c = createMessageBodyCipher({
      keys: ring.provider,
      ringCache: createRingDekCache(ring.provider, { ttlMs: 0 }),
      sealScheme: "ring",
    });
    const before = (await c.seal(ORG_A, "before")).cipher;
    ring.mint(ORG_A, "v2"); // rotation: v2 becomes current, v1 stays retrievable by version
    const after = (await c.seal(ORG_A, "after")).cipher;
    expect(ringEnvelopeVersion(after)).toBe("v2");
    expect(ringEnvelopeVersion(before)).toBe("v1");
    expect(await c.open(ORG_A, before)).toBe("before");
    expect(await c.open(ORG_A, after)).toBe("after");
  });

  it("crypto-shred: once the ring is destroyed (and the cache expired) ring bodies cannot be opened", async () => {
    const ring = fakeRing();
    ring.mint(ORG_A, "v1");
    let t = 0;
    const cache = createRingDekCache(ring.provider, { ttlMs: 60_000, now: () => t });
    const c = createMessageBodyCipher({ ringCache: cache, sealScheme: "ring" });
    const { cipher } = await c.seal(ORG_A, "to be shredded");
    expect(await c.open(ORG_A, cipher)).toBe("to be shredded");
    ring.destroyed.add(ORG_A);
    cache.invalidate(ORG_A); // the in-process shred hook
    await expect(c.open(ORG_A, cipher)).rejects.toThrow(/Destroyed/);
    // and with NO invalidation the exposure is bounded by the TTL
    ring.destroyed.delete(ORG_A);
    await c.open(ORG_A, cipher);
    ring.destroyed.add(ORG_A);
    await c.open(ORG_A, cipher); // still cached inside the TTL
    t += 60_001;
    await expect(c.open(ORG_A, cipher)).rejects.toThrow(/Destroyed/);
  });

  it("the hot path costs one provider call per org per TTL, not one per message", async () => {
    const ring = fakeRing();
    ring.mint(ORG_A, "v1");
    const c = createMessageBodyCipher({ keys: ring.provider, sealScheme: "ring" });
    const sealed = await Promise.all(Array.from({ length: 50 }, (_, i) => c.seal(ORG_A, `m${i}`)));
    await Promise.all(sealed.map((s) => c.open(ORG_A, s.cipher)));
    expect(ring.calls.current).toBe(1);
    expect(ring.calls.version).toBe(1);
  });

  it("fails closed when ring sealing is asked for but no key provider is bound", async () => {
    const c = createMessageBodyCipher({ kek: KEK, sealScheme: "ring" });
    await expect(c.seal(ORG_A, "x")).rejects.toThrow(/not bound/);
  });
});
