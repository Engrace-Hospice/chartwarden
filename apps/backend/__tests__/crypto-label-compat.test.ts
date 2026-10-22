// ChartWarden rename, releases 1-2, for the HKDF / AAD labels of M23, M24, M34, M35 and M36 (body + search tags).
// Every fixture is built here from LITERAL label strings (an oracle independent of the modules' constants):
//   "wardenx..."      = what production holds until the release-2 backfill has run (the legacy label);
//   "chartwarden..."  = what every writer emits since release 2 (the flip), and what the backfill re-seals to.
// Both must be readable (that is what makes the flip, the backfill and a rollback to release 1 safe); anything else (wrong key /
// tampered / other tenant) must still fail closed with a generic error. The single-generation probes (`onlyGeneration`) are what
// the backfill's --verify uses to find rows that open ONLY under the legacy label.
// LEGACY(wardenx->chartwarden): delete the legacy cases after the backfill.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import {
  deriveChannelKey,
  deriveOrgDek,
  deriveOrgDekForGeneration,
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
  deriveOrgCredentialDekForGeneration,
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

  it("seals under the NEW label (flipped in release 2) and not the legacy one", async () => {
    const { cipher: sealed } = await cipher.encrypt(ORG, "s3cret", ctx);
    await expect(cipher.decrypt(ORG, ctx, sealed, "legacy")).rejects.toThrow();
    expect(await cipher.decrypt(ORG, ctx, sealed, "current")).toBe("s3cret");
    const raw = Buffer.from(sealed, "base64");
    const dek = hkdf(KEK, `chartwarden-m23-mac-credential-dek:${ORG}`);
    const d = createDecipheriv("aes-256-gcm", dek, raw.subarray(1, 13));
    d.setAAD(
      Buffer.from(
        ["chartwarden-m23-mac-credential:v2", ORG, ctx.providerEntityId.toLowerCase(), "JF"].join(
          "|",
        ),
      ),
    );
    d.setAuthTag(raw.subarray(raw.length - 16));
    expect(Buffer.concat([d.update(raw.subarray(13, raw.length - 16)), d.final()]).toString()).toBe(
      "s3cret",
    );
  });

  it.each([
    ["wardenx", "legacy", "current"],
    ["chartwarden", "current", "legacy"],
  ] as const)(
    "a %s-sealed secret opens under the %s probe and not the %s one",
    async (prefix, yes, no) => {
      const sealed = sealFixture(prefix, "s3cret");
      expect(await cipher.decrypt(ORG, ctx, sealed, yes)).toBe("s3cret");
      await expect(cipher.decrypt(ORG, ctx, sealed, no)).rejects.toThrow();
    },
  );

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

  it("seals under the NEW label (flipped in release 2) and not the legacy one", () => {
    const sealed = port.seal(ORG, "pw");
    expect(
      openCredentialSecret(sealed, hkdf(KEK, `chartwarden-m24-trading-partner-dek:${ORG}`)),
    ).toBe("pw");
    expect(() =>
      openCredentialSecret(sealed, hkdf(KEK, `wardenx-m24-trading-partner-dek:${ORG}`)),
    ).toThrow();
    expect(
      deriveOrgCredentialDek(KEK, ORG).equals(
        hkdf(KEK, `chartwarden-m24-trading-partner-dek:${ORG}`),
      ),
    ).toBe(true);
  });

  it.each([
    ["wardenx", "legacy", "current"],
    ["chartwarden", "current", "legacy"],
  ] as const)(
    "a %s-sealed credential opens under the %s DEK and not the %s one",
    (prefix, yes, no) => {
      const sealed = fixture(prefix, "pw");
      expect(openCredentialSecret(sealed, deriveOrgCredentialDekForGeneration(KEK, ORG, yes))).toBe(
        "pw",
      );
      expect(() =>
        openCredentialSecret(sealed, deriveOrgCredentialDekForGeneration(KEK, ORG, no)),
      ).toThrow();
    },
  );

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

  it("wraps under the NEW label (flipped in release 2): round trip + oracle check, legacy probe refuses", async () => {
    const { wrappedCiphertextB64 } = await adapter.mintAndWrapDek({ organizationId: ORG });
    const wrapped = Buffer.from(wrappedCiphertextB64, "base64");
    const d = createDecipheriv("aes-256-gcm", KEK, wrapped.subarray(1, 13));
    d.setAAD(Buffer.from(`chartwarden-m34-tenant-dek:v1:${KEK_ID}:${ORG}`));
    d.setAuthTag(wrapped.subarray(13 + 32));
    expect(Buffer.concat([d.update(wrapped.subarray(13, 13 + 32)), d.final()]).length).toBe(32);
    await expect(
      adapter.unwrap({
        organizationId: ORG,
        kekWrappedCiphertext: wrapped,
        kekId: KEK_ID,
        onlyGeneration: "legacy",
      }),
    ).rejects.toThrow(PlatformKekError);
    const back = await adapter.unwrap({
      organizationId: ORG,
      kekWrappedCiphertext: wrapped,
      kekId: KEK_ID,
    });
    expect(back.length).toBe(32);
  });

  it.each([
    ["wardenx", "legacy", "current"],
    ["chartwarden", "current", "legacy"],
  ] as const)(
    "a %s-wrapped DEK unwraps under the %s probe and not the %s one",
    async (prefix, yes, no) => {
      const input = {
        organizationId: ORG,
        kekWrappedCiphertext: wrapFixture(prefix),
        kekId: KEK_ID,
      };
      expect((await adapter.unwrap({ ...input, onlyGeneration: yes })).equals(DEK)).toBe(true);
      await expect(adapter.unwrap({ ...input, onlyGeneration: no })).rejects.toThrow(
        PlatformKekError,
      );
    },
  );

  it("rewrapDek moves a legacy wrap to the new label with the same KEK and the same DEK", async () => {
    const legacy = wrapFixture("wardenx");
    const out = await adapter.rewrapDek({
      organizationId: ORG,
      kekWrappedCiphertext: legacy,
      kekId: KEK_ID,
    });
    expect(out.kekId).toBe(KEK_ID);
    const input = {
      organizationId: ORG,
      kekWrappedCiphertext: Buffer.from(out.wrappedCiphertextB64, "base64"),
      kekId: KEK_ID,
    };
    expect((await adapter.unwrap({ ...input, onlyGeneration: "current" })).equals(DEK)).toBe(true);
    await expect(adapter.unwrap({ ...input, onlyGeneration: "legacy" })).rejects.toThrow();
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

  it("seals under the NEW label (flipped in release 2) and round-trips", () => {
    const { ciphertextB64 } = sealPseudonymKeyMaterial(ring, "epoch-1", KEY);
    expect(openPseudonymKeyMaterial(ring, KEK_ID, "epoch-1", ciphertextB64).equals(KEY)).toBe(true);
    expect(() =>
      openPseudonymKeyMaterial(ring, KEK_ID, "epoch-1", ciphertextB64, "legacy"),
    ).toThrow(PseudonymKekError);
    const wrapped = Buffer.from(ciphertextB64, "base64");
    const d = createDecipheriv("aes-256-gcm", KEK, wrapped.subarray(1, 13));
    d.setAAD(Buffer.from(`chartwarden-m35-pseudonym-key:v1:${KEK_ID}:epoch-1`));
    d.setAuthTag(wrapped.subarray(13 + 32));
    expect(Buffer.concat([d.update(wrapped.subarray(13, 45)), d.final()]).equals(KEY)).toBe(true);
  });

  it.each([
    ["wardenx", "legacy", "current"],
    ["chartwarden", "current", "legacy"],
  ] as const)("%s key material opens under the %s probe and not the %s one", (prefix, yes, no) => {
    expect(
      openPseudonymKeyMaterial(ring, KEK_ID, "epoch-1", fixture(prefix), yes).equals(KEY),
    ).toBe(true);
    expect(() => openPseudonymKeyMaterial(ring, KEK_ID, "epoch-1", fixture(prefix), no)).toThrow(
      PseudonymKekError,
    );
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

  it("derives the NEW-label DEK for sealing (release 2), and a wrong key fails", () => {
    expect(deriveOrgDek(KEK, ORG).equals(hkdf(KEK, `chartwarden-message-dek:${ORG}`))).toBe(true);
    const sealed = sealMessageBody("hello", deriveOrgDek(KEK, ORG));
    expect(() => openMessageBody(sealed, hkdf(KEK, `wardenx-message-dek:${ORG}`))).toThrow();
    expect(() => openMessageBody(sealed, [randomBytes(32), randomBytes(32)])).toThrow();
  });

  it.each([
    ["wardenx", "legacy", "current"],
    ["chartwarden", "current", "legacy"],
  ] as const)(
    "a v1 body sealed under the %s label opens with the %s DEK and not the %s one",
    (prefix, yes, no) => {
      const { nonce, ct, tag } = gcm(
        hkdf(KEK, `${prefix}-message-dek:${ORG}`),
        Buffer.from("hello"),
      );
      const envelope = Buffer.concat([Buffer.from([1]), nonce, ct, tag]);
      expect(openMessageBody(envelope, deriveOrgDekForGeneration(KEK, ORG, yes))).toBe("hello");
      expect(() => openMessageBody(envelope, deriveOrgDekForGeneration(KEK, ORG, no))).toThrow();
    },
  );

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

  it.each([
    ["wardenx", "legacy", "current"],
    ["chartwarden", "current", "legacy"],
  ] as const)(
    "a ring body sealed under the %s AAD label opens with the %s probe and not the %s one",
    (prefix, yes, no) => {
      expect(openMessageBodyRing(ringFixture(prefix), RING_KEY, ORG, yes)).toBe("hi ring");
      expect(() => openMessageBodyRing(ringFixture(prefix), RING_KEY, ORG, no)).toThrow();
    },
  );

  it("seals the ring body under the NEW AAD label (release 2)", () => {
    const sealed = sealMessageBodyRing("x", { version: "v1", key: RING_KEY }, ORG);
    expect(openMessageBodyRing(sealed, RING_KEY, ORG)).toBe("x");
    expect(() => openMessageBodyRing(sealed, RING_KEY, ORG, "legacy")).toThrow();
    const d = createDecipheriv("aes-256-gcm", RING_KEY, sealed.subarray(4, 16));
    d.setAAD(Buffer.from(`chartwarden-message-body:v2:${ORG}:v1`));
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
    // the writer's (new-label, since release 2) set first, then the legacy set.
    expect([...channel.tags]).toEqual([...new Set(oracleTags("chartwarden", "chartwarden"))]);
    expect(channel.alternateTagSets?.map((set) => [...set])).toEqual([
      [...new Set(oracleTags("wardenx", "wardenx"))],
    ]);
  });

  it("the writer's key derivation uses the NEW labels (release 2)", () => {
    const dek = deriveOrgDek(KEK, ORG);
    const search = deriveSearchKey(dek, ORG, VERSION);
    expect(search.equals(hkdf(dek, `chartwarden-message-search:${ORG}:${VERSION}`))).toBe(true);
    expect(
      deriveChannelKey(search, VERSION, BITS, CHANNEL).equals(
        hkdf(search, `chartwarden-message-search-channel:${VERSION}:t${BITS}:${CHANNEL}`),
      ),
    ).toBe(true);
  });
});
