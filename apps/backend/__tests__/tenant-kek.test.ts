/**
 * #105 (F-045) — the platform KEK adapter: the root of M34's per-tenant DEK envelope.
 *
 * Pure crypto + configuration parsing; the live chain (key ring → `TenantKeyProvider` → a real DEK that
 * opens a real HearthNote envelope, and the shred that makes it permanently unreadable) is proved in
 * `m34-tenant-key-provider.live.test.ts`.
 *
 * The cases that matter are the ones a plausible implementation gets wrong:
 *   • the DEK is WRAPPED, not derived — two mints of the same org yield different key material, which is
 *     the whole basis of crypto-erase (a derived DEK is recomputable and destroying its ciphertext
 *     destroys nothing).
 *   • the AAD binds the ORG — a wrapped DEK lifted into another tenant's key ring refuses.
 *   • an unknown `kekId` is named, never brute-forced against the configured keys.
 */
import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  ACTIVE_KEK_ENV,
  PlatformKekError,
  RETIRED_KEK_ENV,
  createPlatformKekAdapter,
  loadPlatformKekRing,
} from "../src/bootstrap/tenant-kek";

const KEY_A = Buffer.alloc(32, 0xa1).toString("base64");
const KEY_B = Buffer.alloc(32, 0xb2).toString("base64");
const ORG = "11111111-1111-4111-8111-111111110001";
const OTHER_ORG = "22222222-2222-4222-8222-222222220002";

const env = (over: Record<string, string | undefined>): NodeJS.ProcessEnv =>
  over as NodeJS.ProcessEnv;

const ringOf = (over: Record<string, string | undefined>) => {
  const ring = loadPlatformKekRing(env(over));
  if (!ring) throw new Error("expected a ring");
  return ring;
};

describe("#105 — platform KEK configuration", () => {
  it("returns null when the active KEK is unset (a dev boot that does no tenant crypto)", () => {
    expect(loadPlatformKekRing(env({}))).toBeNull();
    expect(loadPlatformKekRing(env({ [ACTIVE_KEK_ENV]: "   " }))).toBeNull();
  });

  it("THROWS on a present-but-malformed value rather than degrading to null", () => {
    // The distinction is the point: unset is a choice, malformed is a typo in the platform's root key.
    for (const bad of [
      "no-separator",
      ":missing-id",
      `kek 1:${KEY_A}`,
      `kek-1:${Buffer.alloc(16).toString("base64")}`,
    ]) {
      expect(() => loadPlatformKekRing(env({ [ACTIVE_KEK_ENV]: bad }))).toThrow(PlatformKekError);
    }
  });

  it("collects retired KEKs for unwrap and keeps the active one for wrapping", () => {
    const ring = ringOf({
      [ACTIVE_KEK_ENV]: `kek-2:${KEY_B}`,
      [RETIRED_KEK_ENV]: `kek-1:${KEY_A}`,
    });
    expect(ring.active.kekId).toBe("kek-2");
    expect([...ring.byId.keys()].sort()).toEqual(["kek-1", "kek-2"]);
  });

  it("tolerates the active KEK re-listed as retired, but refuses one id with two keys", () => {
    expect(() =>
      ringOf({ [ACTIVE_KEK_ENV]: `kek-1:${KEY_A}`, [RETIRED_KEK_ENV]: `kek-1:${KEY_A}` }),
    ).not.toThrow();
    expect(() =>
      loadPlatformKekRing(
        env({ [ACTIVE_KEK_ENV]: `kek-1:${KEY_A}`, [RETIRED_KEK_ENV]: `kek-1:${KEY_B}` }),
      ),
    ).toThrow(/declared twice with different key material/);
  });
});

describe("#105 — platform KEK wrap/unwrap", () => {
  const adapter = createPlatformKekAdapter(ringOf({ [ACTIVE_KEK_ENV]: `kek-1:${KEY_A}` }));
  const unwrapOf = async (
    a: ReturnType<typeof createPlatformKekAdapter>,
    org: string,
    wrapped: { wrappedCiphertextB64: string; kekId: string },
  ) =>
    a.unwrap({
      organizationId: org,
      kekWrappedCiphertext: Buffer.from(wrapped.wrappedCiphertextB64, "base64"),
      kekId: wrapped.kekId,
    });

  it("round-trips a 256-bit DEK and names the wrapping KEK", async () => {
    const wrapped = await adapter.mintAndWrapDek({ organizationId: ORG });
    expect(wrapped.kekId).toBe("kek-1");
    const dek = await unwrapOf(adapter, ORG, wrapped);
    expect(dek).toHaveLength(32);
    // v(1) + nonce(12) + dek(32) + tag(16)
    expect(Buffer.from(wrapped.wrappedCiphertextB64, "base64")).toHaveLength(61);
  });

  it("MINTS random key material rather than deriving it — the property crypto-erase rests on", async () => {
    const [one, two] = await Promise.all([
      adapter.mintAndWrapDek({ organizationId: ORG }),
      adapter.mintAndWrapDek({ organizationId: ORG }),
    ]);
    const [dekOne, dekTwo] = await Promise.all([
      unwrapOf(adapter, ORG, one),
      unwrapOf(adapter, ORG, two),
    ]);
    // A DEK derived from (KEK, orgId) — M24/M36's model — would be byte-identical here, and destroying
    // the stored ciphertext would destroy nothing because the key stays recomputable from an env var.
    expect(dekOne.equals(dekTwo)).toBe(false);
  });

  it("refuses a wrapped DEK presented under ANOTHER organization (the AAD binds the tenant)", async () => {
    const wrapped = await adapter.mintAndWrapDek({ organizationId: ORG });
    await expect(unwrapOf(adapter, OTHER_ORG, wrapped)).rejects.toThrow(/failed authentication/);
  });

  it("refuses a tampered ciphertext", async () => {
    const wrapped = await adapter.mintAndWrapDek({ organizationId: ORG });
    const bytes = Buffer.from(wrapped.wrappedCiphertextB64, "base64");
    bytes[20] ^= 0xff;
    await expect(
      adapter.unwrap({ organizationId: ORG, kekWrappedCiphertext: bytes, kekId: "kek-1" }),
    ).rejects.toThrow(/failed authentication/);
  });

  it("NAMES an unconfigured kekId instead of trying the keys it does have", async () => {
    const wrapped = await adapter.mintAndWrapDek({ organizationId: ORG });
    await expect(unwrapOf(adapter, ORG, { ...wrapped, kekId: "kek-9" })).rejects.toThrow(
      new RegExp(`no platform KEK 'kek-9' is configured.*${RETIRED_KEK_ENV}`),
    );
  });

  it("survives a KEK rotation: a retired KEK still opens the rings it wrapped", async () => {
    const old = createPlatformKekAdapter(ringOf({ [ACTIVE_KEK_ENV]: `kek-1:${KEY_A}` }));
    const wrapped = await old.mintAndWrapDek({ organizationId: ORG });
    const rotated = createPlatformKekAdapter(
      ringOf({ [ACTIVE_KEK_ENV]: `kek-2:${KEY_B}`, [RETIRED_KEK_ENV]: `kek-1:${KEY_A}` }),
    );
    expect(await unwrapOf(rotated, ORG, wrapped)).toHaveLength(32);
    // New DEKs are wrapped under the ACTIVE key, never the retired one.
    expect((await rotated.mintAndWrapDek({ organizationId: ORG })).kekId).toBe("kek-2");
    // And dropping the retired entry is what makes the old rings unreadable — the rotation footgun.
    const dropped = createPlatformKekAdapter(ringOf({ [ACTIVE_KEK_ENV]: `kek-2:${KEY_B}` }));
    await expect(unwrapOf(dropped, ORG, wrapped)).rejects.toThrow(/no platform KEK 'kek-1'/);
  });

  it("rejects a malformed wrapped DEK by shape before touching the cipher", async () => {
    await expect(
      adapter.unwrap({
        organizationId: ORG,
        kekWrappedCiphertext: Buffer.alloc(10),
        kekId: "kek-1",
      }),
    ).rejects.toThrow(/expected 61/);
  });
});
