// ChartWarden rename, release 1 (READ-SIDE) for the HKDF / AAD labels of M23, M24, M34, M35 and M36 (body + search tags).
// Every fixture is built here from LITERAL label strings (an oracle independent of the modules' constants):
//   "wardenx..."      = what production holds today (and what every writer still emits in this release);
//   "chartwarden..."  = what the future writer flip (release 2) will emit.
// Both must be readable; anything else (wrong key / tampered / other tenant) must still fail closed with a generic error.
// LEGACY(wardenx->chartwarden): delete the legacy cases after the backfill.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import {
  deriveChannelKey,
  deriveOrgDek,
  deriveSearchKey,
  openMessageBody,
  openMessageBodyRing,
  sealMessageBody,
  sealMessageBodyRing,
} from "@chartwarden/messaging";
import {
  PseudonymKekError,
  openPseudonymKeyMaterial,
  sealPseudonymKeyMaterial,
} from "@chartwarden/subscription-billing";
import { describe, expect, it } from "vitest";
import { PlatformKekError, createPlatformKekAdapter } from "../src/bootstrap/tenant-kek";
import { buildMacSecretCipher } from "../src/modules/23-billing-medicare/routes/secret-cipher";
import {
  buildCredentialCipherPort,
  deriveOrgCredentialDek,
  openCredentialSecret,
} from "../src/modules/24-billing-medicaid/credential-crypto";
import {
  type ChannelQuery,
  buildVersionQueries,
  tagsForTerms,
} from "../src/modules/36-messaging/global-search/query-terms";
import { createLegacyTestSearchKeyProvider } from "../src/modules/36-messaging/global-search/search-key-provider";

const ORG = "00000000-0000-4000-8000-00000000000a";
const OTHER_ORG = "00000000-0000-4000-8000-00000000000b";
const KEK = randomBytes(32);
const hkdf = (ikm: Buffer, info: string): Buffer =>
  Buffer.from(hkdfSync("sha256", ikm, Buffer.alloc(0), info, 32));
const PREFIXES = ["wardenx", "chartwarden"] as const;

/** AES-256-GCM seal with an explicit AAD, returning nonce | ct | tag pieces. */
function gcm(key: Buffer, plaintext: Buffer, aad?: string) {
  const nonce = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, nonce);
  if (aad !== undefined) c.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([c.update(plaintext), c.final()]);
  return { nonce, ct, tag: c.getAuthTag() };
}
const flipLastByte = (b: Buffer): Buffer => {
  const out = Buffer.from(b);
  out[out.length - 1] = (out[out.length - 1] as number) ^ 0xff;
  return out;
};

describe("M23 MAC secret cipher labels", () => {
  const cipher = buildMacSecretCipher(KEK);
  const ctx = { providerEntityId: "AAAAAAAA-0000-4000-8000-000000000001", macJurisdiction: "JF" };
  const sealFixture = (prefix: string, secret: string): string => {
    const dek = hkdf(KEK, `${prefix}-m23-mac-credential-dek:${ORG}`);
    const aad = [
      `${prefix}-m23-mac-credential:v2`,
      ORG,
      ctx.providerEntityId.toLowerCase(),
      "JF",
    ].join("|");
    const { nonce, ct, tag } = gcm(dek, Buffer.from(secret), aad);
    return Buffer.concat([Buffer.from([2]), nonce, ct, tag]).toString("base64");
  };

  it.each(PREFIXES)("opens a secret sealed under the %s label", async (prefix) => {
    expect(await cipher.decrypt(ORG, ctx, sealFixture(prefix, "s3cret"))).toBe("s3cret");
  });

  it("still seals under the legacy label in this release", async () => {
    const { cipher: sealed } = await cipher.encrypt(ORG, "s3cret", ctx);
    const raw = Buffer.from(sealed, "base64");
    const dek = hkdf(KEK, `wardenx-m23-mac-credential-dek:${ORG}`);
    const d = createDecipheriv("aes-256-gcm", dek, raw.subarray(1, 13));
    d.setAAD(
      Buffer.from(
        ["wardenx-m23-mac-credential:v2", ORG, ctx.providerEntityId.toLowerCase(), "JF"].join("|"),
      ),
    );
    d.setAuthTag(raw.subarray(raw.length - 16));
    expect(Buffer.concat([d.update(raw.subarray(13, raw.length - 16)), d.final()]).toString()).toBe(
      "s3cret",
    );
  });

  it.each(PREFIXES)(
    "fails closed (generic error) for %s data: tamper, other tenant, other row",
    async (prefix) => {
      const sealed = sealFixture(prefix, "s3cret");
      const bad = [
        cipher.decrypt(ORG, ctx, flipLastByte(Buffer.from(sealed, "base64")).toString("base64")),
        cipher.decrypt(OTHER_ORG, ctx, sealed),
        cipher.decrypt(ORG, { ...ctx, macJurisdiction: "JE" }, sealed),
      ];
      for (const p of bad) {
        const err = await p.catch((e: Error) => e);
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toBe("MAC secret cipher: ciphertext failed authentication");
      }
    },
  );
});

describe("M24 trading-partner credential labels", () => {
  const port = buildCredentialCipherPort(KEK);
  const fixture = (prefix: string, secret: string): string => {
    const { nonce, ct, tag } = gcm(
      hkdf(KEK, `${prefix}-m24-trading-partner-dek:${ORG}`),
      Buffer.from(secret),
    );
    return Buffer.concat([Buffer.from([1]), nonce, ct, tag]).toString("base64");
  };

  it.each(PREFIXES)("opens a credential sealed under the %s label", (prefix) => {
    expect(port.open(ORG, fixture(prefix, "pw"))).toBe("pw");
  });

  it("still seals under the legacy label in this release", () => {
    expect(
      openCredentialSecret(
        port.seal(ORG, "pw"),
        hkdf(KEK, `wardenx-m24-trading-partner-dek:${ORG}`),
      ),
    ).toBe("pw");
    expect(
      deriveOrgCredentialDek(KEK, ORG).equals(hkdf(KEK, `wardenx-m24-trading-partner-dek:${ORG}`)),
    ).toBe(true);
  });

  it.each(PREFIXES)("fails closed for %s data: tamper and other tenant", (prefix) => {
    const sealed = fixture(prefix, "pw");
    expect(() =>
      port.open(ORG, flipLastByte(Buffer.from(sealed, "base64")).toString("base64")),
    ).toThrow();
    expect(() => port.open(OTHER_ORG, sealed)).toThrow();
  });
});

describe("M34 tenant key-ring wrap label (highest risk)", () => {
  const KEK_ID = "kek-1";
  const adapter = createPlatformKekAdapter({
    active: { kekId: KEK_ID, key: KEK },
    byId: new Map([[KEK_ID, KEK]]),
  });
  const DEK = randomBytes(32);
  const wrapFixture = (prefix: string, org = ORG): Buffer => {
    const { nonce, ct, tag } = gcm(KEK, DEK, `${prefix}-m34-tenant-dek:v1:${KEK_ID}:${org}`);
    return Buffer.concat([Buffer.from([1]), nonce, ct, tag]);
  };

  it.each(PREFIXES)("unwraps a DEK wrapped under the %s label", async (prefix) => {
    const out = await adapter.unwrap({
      organizationId: ORG,
      kekWrappedCiphertext: wrapFixture(prefix),
      kekId: KEK_ID,
    });
    expect(out.equals(DEK)).toBe(true);
  });

  it("still wraps under the legacy label in this release (round trip + oracle check)", async () => {
    const { wrappedCiphertextB64 } = await adapter.mintAndWrapDek({ organizationId: ORG });
    const wrapped = Buffer.from(wrappedCiphertextB64, "base64");
    const d = createDecipheriv("aes-256-gcm", KEK, wrapped.subarray(1, 13));
    d.setAAD(Buffer.from(`wardenx-m34-tenant-dek:v1:${KEK_ID}:${ORG}`));
    d.setAuthTag(wrapped.subarray(13 + 32));
    expect(Buffer.concat([d.update(wrapped.subarray(13, 13 + 32)), d.final()]).length).toBe(32);
    const back = await adapter.unwrap({
      organizationId: ORG,
      kekWrappedCiphertext: wrapped,
      kekId: KEK_ID,
    });
    expect(back.length).toBe(32);
  });

  it.each(PREFIXES)(
    "refuses a %s-wrapped DEK lifted into another tenant, with one generic error",
    async (prefix) => {
      const err = await adapter
        .unwrap({
          organizationId: OTHER_ORG,
          kekWrappedCiphertext: wrapFixture(prefix),
          kekId: KEK_ID,
        })
        .catch((e: Error) => e);
      expect(err).toBeInstanceOf(PlatformKekError);
      expect((err as Error).message).not.toMatch(/wardenx|chartwarden|label/i);
    },
  );

  it("refuses a tampered wrap and an unknown label", async () => {
    await expect(
      adapter.unwrap({
        organizationId: ORG,
        kekWrappedCiphertext: flipLastByte(wrapFixture("wardenx")),
        kekId: KEK_ID,
      }),
    ).rejects.toThrow(PlatformKekError);
    await expect(
      adapter.unwrap({
        organizationId: ORG,
        kekWrappedCiphertext: wrapFixture("otherapp"),
        kekId: KEK_ID,
      }),
    ).rejects.toThrow(PlatformKekError);
  });
});

describe("M35 pseudonym key-material labels", () => {
  const KEK_ID = "kek-1";
  const ring = { active: { kekId: KEK_ID, key: KEK }, byId: new Map([[KEK_ID, KEK]]) };
  const KEY = randomBytes(32);
  const fixture = (prefix: string): string => {
    const { nonce, ct, tag } = gcm(KEK, KEY, `${prefix}-m35-pseudonym-key:v1:${KEK_ID}:epoch-1`);
    return Buffer.concat([Buffer.from([1]), nonce, ct, tag]).toString("base64");
  };

  it.each(PREFIXES)("opens key material sealed under the %s label", (prefix) => {
    expect(openPseudonymKeyMaterial(ring, KEK_ID, "epoch-1", fixture(prefix)).equals(KEY)).toBe(
      true,
    );
  });

  it("seals under the legacy label in this release and round-trips", () => {
    const { ciphertextB64 } = sealPseudonymKeyMaterial(ring, "epoch-1", KEY);
    expect(openPseudonymKeyMaterial(ring, KEK_ID, "epoch-1", ciphertextB64).equals(KEY)).toBe(true);
    const wrapped = Buffer.from(ciphertextB64, "base64");
    const d = createDecipheriv("aes-256-gcm", KEK, wrapped.subarray(1, 13));
    d.setAAD(Buffer.from(`wardenx-m35-pseudonym-key:v1:${KEK_ID}:epoch-1`));
    d.setAuthTag(wrapped.subarray(13 + 32));
    expect(Buffer.concat([d.update(wrapped.subarray(13, 45)), d.final()]).equals(KEY)).toBe(true);
  });

  it.each(PREFIXES)("fails closed for %s data on another epoch", (prefix) => {
    expect(() => openPseudonymKeyMaterial(ring, KEK_ID, "epoch-2", fixture(prefix))).toThrow(
      PseudonymKekError,
    );
  });
});

describe("M36 message body labels", () => {
  it.each(PREFIXES)("opens a v1 (HKDF) body whose DEK was derived under the %s label", (prefix) => {
    const dek = hkdf(KEK, `${prefix}-message-dek:${ORG}`);
    const { nonce, ct, tag } = gcm(dek, Buffer.from("hello"));
    const envelope = Buffer.concat([Buffer.from([1]), nonce, ct, tag]);
    expect(
      openMessageBody(envelope, [
        hkdf(KEK, `chartwarden-message-dek:${ORG}`),
        hkdf(KEK, `wardenx-message-dek:${ORG}`),
      ]),
    ).toBe("hello");
  });

  it("still derives the legacy DEK for sealing, and a wrong key fails", () => {
    expect(deriveOrgDek(KEK, ORG).equals(hkdf(KEK, `wardenx-message-dek:${ORG}`))).toBe(true);
    const sealed = sealMessageBody("hello", deriveOrgDek(KEK, ORG));
    expect(() => openMessageBody(sealed, [randomBytes(32), randomBytes(32)])).toThrow();
  });

  const RING_KEY = randomBytes(32);
  const ringFixture = (prefix: string, org = ORG): Buffer => {
    const { nonce, ct, tag } = gcm(
      RING_KEY,
      Buffer.from("hi ring"),
      `${prefix}-message-body:v2:${org}:v1`,
    );
    return Buffer.concat([Buffer.from([2, 2]), Buffer.from("v1"), nonce, ct, tag]);
  };

  it.each(PREFIXES)("opens a ring (v2) body sealed under the %s AAD label", (prefix) => {
    expect(openMessageBodyRing(ringFixture(prefix), RING_KEY, ORG)).toBe("hi ring");
  });

  it("seals the ring body under the legacy AAD label in this release", () => {
    const sealed = sealMessageBodyRing("x", { version: "v1", key: RING_KEY }, ORG);
    expect(openMessageBodyRing(sealed, RING_KEY, ORG)).toBe("x");
    const d = createDecipheriv("aes-256-gcm", RING_KEY, sealed.subarray(4, 16));
    d.setAAD(Buffer.from(`wardenx-message-body:v2:${ORG}:v1`));
    d.setAuthTag(sealed.subarray(sealed.length - 16));
    expect(
      Buffer.concat([d.update(sealed.subarray(16, sealed.length - 16)), d.final()]).toString(),
    ).toBe("x");
  });

  it.each(PREFIXES)("fails closed for %s ring data under another tenant or tampered", (prefix) => {
    expect(() => openMessageBodyRing(ringFixture(prefix), RING_KEY, OTHER_ORG)).toThrow();
    expect(() => openMessageBodyRing(flipLastByte(ringFixture(prefix)), RING_KEY, ORG)).toThrow();
  });
});

describe("M36 global-search tag labels (query side dual probe)", () => {
  const keys = createLegacyTestSearchKeyProvider(KEK);
  const VERSION = "legacy";
  const BITS = 16;
  const CHANNEL = "cccccccc-0000-4000-8000-000000000001";
  const TERM = "hospice";
  const oracleTags = (prefix: string, kekPrefix: string): number[] => {
    const dek = hkdf(KEK, `${kekPrefix}-message-dek:${ORG}`);
    const search = hkdf(dek, `${prefix}-message-search:${ORG}:${VERSION}`);
    const channel = hkdf(search, `${prefix}-message-search-channel:${VERSION}:t${BITS}:${CHANNEL}`);
    return tagsForTerms(channel, [TERM], BITS);
  };

  it("probes the tags of rows indexed under the legacy label AND under the new label", async () => {
    const built = await buildVersionQueries(
      keys,
      ORG,
      [{ keyVersion: VERSION, tagBits: BITS, headBuckets: new Set() }],
      [TERM],
      [CHANNEL],
    );
    const channel = built.queries[0]?.channels[0] as ChannelQuery;
    // two INDEPENDENT conjunctions (never one merged list: the SQL requires ALL tags of ONE set on a message):
    // the writer's (legacy) set first, then the new-label set.
    expect([...channel.tags]).toEqual([...new Set(oracleTags("wardenx", "wardenx"))]);
    expect(channel.alternateTagSets?.map((set) => [...set])).toEqual([
      [...new Set(oracleTags("chartwarden", "chartwarden"))],
    ]);
  });

  it("the writer's key derivation is unchanged (legacy labels)", () => {
    const dek = deriveOrgDek(KEK, ORG);
    const search = deriveSearchKey(dek, ORG, VERSION);
    expect(search.equals(hkdf(dek, `wardenx-message-search:${ORG}:${VERSION}`))).toBe(true);
    expect(
      deriveChannelKey(search, VERSION, BITS, CHANNEL).equals(
        hkdf(search, `wardenx-message-search-channel:${VERSION}:t${BITS}:${CHANNEL}`),
      ),
    ).toBe(true);
  });
});
