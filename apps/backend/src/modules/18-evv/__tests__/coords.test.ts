// apps/backend/src/modules/18-evv/__tests__/coords.test.ts — the `evv_event.coords_cipher` envelope (GAP-133).
//
// GAP-032 made the read recover what the write stored; GAP-133 makes what the write stores actual ciphertext.
// The column used to hold `base64("lat,lng")` stamped `coords_dek_version = 1` — encoding dressed up as
// encryption. These tests pin the four properties that make it real: a round-trip through AES-256-GCM under
// the tenant's M34 DEK, a blob that will not open under another tenant or another key, the DEK version that is
// stamped being the one the key ring actually returned, and a write that REFUSES when no key is bound rather
// than falling back to the old encoding.
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  type EvvCoordsKeyProvider,
  EvvCoordsKeyUnboundError,
  LEGACY_COORDS_DEK_VERSION,
  UNBOUND_EVV_COORDS_CIPHER,
  createEvvCoordsCipher,
  isLegacyStoredCoords,
  lazyEvvCoordsKeys,
} from "../coords";

const ORG_A = "00000000-0000-4000-8000-00000000000a";
const ORG_B = "00000000-0000-4000-8000-00000000000b";
const PORTLAND = { lat: 45.5152, lng: -122.6784 }; // the seed data's home base

/** A per-tenant key ring: each org has its own DEKs, keyed by version. */
function keyRing(active: Record<string, string>, keys: Map<string, Buffer>): EvvCoordsKeyProvider {
  return {
    async dekForOrg(organizationId) {
      const version = active[organizationId];
      const key = version === undefined ? undefined : keys.get(`${organizationId}:${version}`);
      if (version === undefined || key === undefined) throw new Error("tenant key missing");
      return { version, key };
    },
    async dekForOrgVersion(organizationId, version) {
      const key = keys.get(`${organizationId}:${version}`);
      if (key === undefined) throw new Error("tenant key version missing");
      return { version, key };
    },
  };
}

function freshKeys(): Map<string, Buffer> {
  return new Map([
    [`${ORG_A}:v1`, randomBytes(32)],
    [`${ORG_A}:v2`, randomBytes(32)],
    [`${ORG_B}:v1`, randomBytes(32)],
  ]);
}

/** The legacy pre-GAP-133 format, reproduced here only to prove the reader refuses to trust it. */
const legacyBase64 = (c: { lat: number; lng: number }): string =>
  Buffer.from(`${c.lat},${c.lng}`).toString("base64");

describe("M18 coords envelope (GAP-133)", () => {
  it("round-trips a captured coordinate through ciphertext that does not contain it", async () => {
    const cipher = createEvvCoordsCipher(keyRing({ [ORG_A]: "v1" }, freshKeys()));
    const sealed = await cipher.seal(ORG_A, PORTLAND);
    expect(sealed.cipher).not.toContain("45.5152");
    expect(sealed.cipher).not.toBe(legacyBase64(PORTLAND));
    expect(Buffer.from(sealed.cipher, "base64").toString("utf8")).not.toContain("45.5152");
    expect(await cipher.open(ORG_A, sealed.cipher)).toEqual(PORTLAND);
  });

  it("round-trips the extremes and a genuine zero pair", async () => {
    const cipher = createEvvCoordsCipher(keyRing({ [ORG_A]: "v1" }, freshKeys()));
    for (const coords of [
      { lat: 90, lng: 180 },
      { lat: -90, lng: -180 },
      { lat: 0, lng: 0 }, // (0, 0) is a VALID coordinate and must survive the round-trip
    ]) {
      const sealed = await cipher.seal(ORG_A, coords);
      expect(await cipher.open(ORG_A, sealed.cipher)).toEqual(coords);
    }
  });

  it("stamps the DEK version the key ring actually returned, not a constant", async () => {
    const keys = freshKeys();
    const v1 = await createEvvCoordsCipher(keyRing({ [ORG_A]: "v1" }, keys)).seal(ORG_A, PORTLAND);
    const v2 = await createEvvCoordsCipher(keyRing({ [ORG_A]: "v2" }, keys)).seal(ORG_A, PORTLAND);
    expect(v1.dekVersion).toBe("v1");
    expect(v2.dekVersion).toBe("v2");
  });

  it("uses a fresh nonce per seal (two seals of one coordinate differ)", async () => {
    const cipher = createEvvCoordsCipher(keyRing({ [ORG_A]: "v1" }, freshKeys()));
    const a = await cipher.seal(ORG_A, PORTLAND);
    const b = await cipher.seal(ORG_A, PORTLAND);
    expect(a.cipher).not.toBe(b.cipher);
  });

  it("opens a row sealed under a previous DEK version after rotation", async () => {
    const keys = freshKeys();
    const sealed = await createEvvCoordsCipher(keyRing({ [ORG_A]: "v1" }, keys)).seal(
      ORG_A,
      PORTLAND,
    );
    const rotated = createEvvCoordsCipher(keyRing({ [ORG_A]: "v2" }, keys));
    expect(await rotated.open(ORG_A, sealed.cipher)).toEqual(PORTLAND);
  });

  it("refuses to open a blob under another tenant (AAD binds the org)", async () => {
    const keys = freshKeys();
    const cipher = createEvvCoordsCipher(keyRing({ [ORG_A]: "v1", [ORG_B]: "v1" }, keys));
    const sealed = await cipher.seal(ORG_A, PORTLAND);
    await expect(cipher.open(ORG_B, sealed.cipher)).rejects.toThrow();
  });

  it("refuses to open a blob with the wrong tenant key, even under the right org id", async () => {
    const sealed = await createEvvCoordsCipher(keyRing({ [ORG_A]: "v1" }, freshKeys())).seal(
      ORG_A,
      PORTLAND,
    );
    // Same org, same version label, DIFFERENT key material (e.g. a lifted row or a re-minted ring).
    const other = createEvvCoordsCipher(keyRing({ [ORG_A]: "v1" }, freshKeys()));
    await expect(other.open(ORG_A, sealed.cipher)).rejects.toThrow();
  });

  it("throws on a tampered envelope rather than returning a wrong coordinate", async () => {
    const cipher = createEvvCoordsCipher(keyRing({ [ORG_A]: "v1" }, freshKeys()));
    const sealed = await cipher.seal(ORG_A, PORTLAND);
    const parts = sealed.cipher.split(".");
    const ct = Buffer.from(parts[4] as string, "base64url");
    ct[0] = (ct[0] as number) ^ 0x01;
    const tampered = [...parts.slice(0, 4), ct.toString("base64url")].join(".");
    await expect(cipher.open(ORG_A, tampered)).rejects.toThrow();
  });

  it("propagates a missing tenant key on read (fail loud, never a silent null)", async () => {
    const sealed = await createEvvCoordsCipher(keyRing({ [ORG_A]: "v1" }, freshKeys())).seal(
      ORG_A,
      PORTLAND,
    );
    const destroyed = createEvvCoordsCipher(keyRing({}, new Map()));
    await expect(destroyed.open(ORG_A, sealed.cipher)).rejects.toThrow(/missing/);
  });

  it("refuses to seal an out-of-range or non-finite coordinate", async () => {
    const cipher = createEvvCoordsCipher(keyRing({ [ORG_A]: "v1" }, freshKeys()));
    for (const bad of [
      { lat: 91, lng: 0 },
      { lat: 0, lng: 181 },
      { lat: Number.NaN, lng: 0 },
      { lat: 0, lng: Number.POSITIVE_INFINITY },
    ]) {
      await expect(cipher.seal(ORG_A, bad)).rejects.toThrow();
    }
  });

  it("rejects a DEK that is not 32 bytes", async () => {
    const cipher = createEvvCoordsCipher({
      async dekForOrg() {
        return { version: "v1", key: Buffer.alloc(16) };
      },
      async dekForOrgVersion() {
        return { version: "v1", key: Buffer.alloc(16) };
      },
    });
    await expect(cipher.seal(ORG_A, PORTLAND)).rejects.toThrow(/32 bytes/);
  });

  it("returns null for an absent payload rather than a fabricated origin", async () => {
    const cipher = createEvvCoordsCipher(keyRing({ [ORG_A]: "v1" }, freshKeys()));
    expect(await cipher.open(ORG_A, null)).toBeNull();
    expect(await cipher.open(ORG_A, undefined)).toBeNull();
    expect(await cipher.open(ORG_A, "")).toBeNull();
  });

  describe("legacy pre-GAP-133 rows (base64, never encrypted)", () => {
    it("are recognised by format — base64 has no '.' so it can never collide with an envelope", async () => {
      expect(isLegacyStoredCoords(legacyBase64(PORTLAND))).toBe(true);
      const sealed = await createEvvCoordsCipher(keyRing({ [ORG_A]: "v1" }, freshKeys())).seal(
        ORG_A,
        PORTLAND,
      );
      expect(isLegacyStoredCoords(sealed.cipher)).toBe(false);
      expect(isLegacyStoredCoords(null)).toBe(false);
    });

    it("read as unavailable (null) — never decoded, never a crash, and no key is consulted", async () => {
      let consulted = false;
      const cipher = createEvvCoordsCipher({
        async dekForOrg() {
          consulted = true;
          throw new Error("unexpected");
        },
        async dekForOrgVersion() {
          consulted = true;
          throw new Error("unexpected");
        },
      });
      expect(await cipher.open(ORG_A, legacyBase64(PORTLAND))).toBeNull();
      expect(consulted).toBe(false);
    });

    it("carry the sentinel DEK version migration 0491 stamps on them", () => {
      expect(LEGACY_COORDS_DEK_VERSION).toBe("legacy-unencrypted");
    });
  });

  describe("fail closed when no key is bound", () => {
    it("refuses every write — no fallback to the base64 encoding", async () => {
      await expect(UNBOUND_EVV_COORDS_CIPHER.seal(ORG_A, PORTLAND)).rejects.toBeInstanceOf(
        EvvCoordsKeyUnboundError,
      );
    });

    it("refuses to open a real envelope, but still reads absent/legacy payloads as null", async () => {
      const sealed = await createEvvCoordsCipher(keyRing({ [ORG_A]: "v1" }, freshKeys())).seal(
        ORG_A,
        PORTLAND,
      );
      await expect(UNBOUND_EVV_COORDS_CIPHER.open(ORG_A, sealed.cipher)).rejects.toBeInstanceOf(
        EvvCoordsKeyUnboundError,
      );
      expect(await UNBOUND_EVV_COORDS_CIPHER.open(ORG_A, null)).toBeNull();
      expect(await UNBOUND_EVV_COORDS_CIPHER.open(ORG_A, legacyBase64(PORTLAND))).toBeNull();
    });

    it("a key provider that refuses (M34's unbound KEK stub) makes the seal throw", async () => {
      const cipher = createEvvCoordsCipher(keyRing({}, new Map()));
      await expect(cipher.seal(ORG_A, PORTLAND)).rejects.toThrow(/missing/);
    });
  });

  it("lazyEvvCoordsKeys resolves the provider per call (M34 binds after the seams are wired)", async () => {
    let bound: EvvCoordsKeyProvider | null = null;
    const cipher = createEvvCoordsCipher(
      lazyEvvCoordsKeys(() => {
        if (bound === null) throw new Error("not yet bound");
        return bound;
      }),
    );
    await expect(cipher.seal(ORG_A, PORTLAND)).rejects.toThrow(/not yet bound/);
    bound = keyRing({ [ORG_A]: "v1" }, freshKeys());
    const sealed = await cipher.seal(ORG_A, PORTLAND);
    expect(await cipher.open(ORG_A, sealed.cipher)).toEqual(PORTLAND);
  });
});
