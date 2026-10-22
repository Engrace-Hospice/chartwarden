// ChartWarden rename, release 3 (the legacy labels are gone), for the HKDF / AAD labels of M23, M24, M34, M35 and M36 (body + search).
// Every fixture is built here from LITERAL label strings (an oracle independent of the modules' constants):
//   "chartwarden..."  = what every writer has emitted since release 2: it must open, and the writers must still emit it;
//   "wardenx..."      = the legacy label: since release 3 a value sealed under it must FAIL CLOSED, with the same generic error as
//                       any other value that does not authenticate (tamper, wrong key, other tenant), and no error names a label.
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
  buildVersionQueries,
  tagsForTerms,
} from "../src/modules/36-messaging/global-search/query-terms";
import { createLegacyTestSearchKeyProvider } from "../src/modules/36-messaging/global-search/search-key-provider";

const ORG = "00000000-0000-4000-8000-00000000000a";
const OTHER_ORG = "00000000-0000-4000-8000-00000000000b";
const KEK = randomBytes(32);
const hkdf = (ikm: Buffer, info: string): Buffer =>
  Buffer.from(hkdfSync("sha256", ikm, Buffer.alloc(0), info, 32));
const NO_LABEL_NAMED = /wardenx|chartwarden|label/i;

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
  const GENERIC = "MAC secret cipher: ciphertext failed authentication";
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

  it("opens a secret sealed under the chartwarden label", async () => {
    expect(await cipher.decrypt(ORG, ctx, sealFixture("chartwarden", "s3cret"))).toBe("s3cret");
  });

  it("seals under the chartwarden label (oracle check)", async () => {
    const { cipher: sealed } = await cipher.encrypt(ORG, "s3cret", ctx);
    const raw = Buffer.from(sealed, "base64");
    const d = createDecipheriv(
      "aes-256-gcm",
      hkdf(KEK, `chartwarden-m23-mac-credential-dek:${ORG}`),
      raw.subarray(1, 13),
    );
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

  it("FAILS CLOSED on a legacy (wardenx) secret, with the generic error", async () => {
    const err = await cipher
      .decrypt(ORG, ctx, sealFixture("wardenx", "s3cret"))
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe(GENERIC);
  });

  it("fails closed with the generic error: tamper, other tenant, other row", async () => {
    const sealed = sealFixture("chartwarden", "s3cret");
    const bad = [
      cipher.decrypt(ORG, ctx, flipLastByte(Buffer.from(sealed, "base64")).toString("base64")),
      cipher.decrypt(OTHER_ORG, ctx, sealed),
      cipher.decrypt(ORG, { ...ctx, macJurisdiction: "JE" }, sealed),
    ];
    for (const p of bad) {
      const err = await p.catch((e: Error) => e);
      expect((err as Error).message).toBe(GENERIC);
    }
  });
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

  it("opens a credential sealed under the chartwarden label", () => {
    expect(port.open(ORG, fixture("chartwarden", "pw"))).toBe("pw");
  });

  it("seals under the chartwarden label (oracle check)", () => {
    const sealed = port.seal(ORG, "pw");
    expect(
      openCredentialSecret(sealed, hkdf(KEK, `chartwarden-m24-trading-partner-dek:${ORG}`)),
    ).toBe("pw");
    expect(
      deriveOrgCredentialDek(KEK, ORG).equals(
        hkdf(KEK, `chartwarden-m24-trading-partner-dek:${ORG}`),
      ),
    ).toBe(true);
  });

  it("FAILS CLOSED on a legacy (wardenx) credential", () => {
    expect(() => port.open(ORG, fixture("wardenx", "pw"))).toThrow();
  });

  it("fails closed: tamper and other tenant", () => {
    const sealed = fixture("chartwarden", "pw");
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
  const unwrap = (wrapped: Buffer, org = ORG) =>
    adapter.unwrap({ organizationId: org, kekWrappedCiphertext: wrapped, kekId: KEK_ID });

  it("unwraps a DEK wrapped under the chartwarden label", async () => {
    expect((await unwrap(wrapFixture("chartwarden"))).equals(DEK)).toBe(true);
  });

  it("wraps under the chartwarden label (oracle check) and round-trips", async () => {
    const { wrappedCiphertextB64 } = await adapter.mintAndWrapDek({ organizationId: ORG });
    const wrapped = Buffer.from(wrappedCiphertextB64, "base64");
    const d = createDecipheriv("aes-256-gcm", KEK, wrapped.subarray(1, 13));
    d.setAAD(Buffer.from(`chartwarden-m34-tenant-dek:v1:${KEK_ID}:${ORG}`));
    d.setAuthTag(wrapped.subarray(13 + 32));
    expect(Buffer.concat([d.update(wrapped.subarray(13, 13 + 32)), d.final()]).length).toBe(32);
    expect((await unwrap(wrapped)).length).toBe(32);
  });

  it("FAILS CLOSED on a legacy (wardenx) wrap, with the one generic error that names no label", async () => {
    const err = await unwrap(wrapFixture("wardenx")).catch((e: Error) => e);
    expect(err).toBeInstanceOf(PlatformKekError);
    expect((err as Error).message).toBe(
      `wrapped DEK for org ${ORG} failed authentication under KEK '${KEK_ID}'`,
    );
    expect((err as Error).message).not.toMatch(/wardenx|label/i);
  });

  it.each(["chartwarden", "wardenx"])(
    "refuses a %s-wrapped DEK lifted into another tenant, with one generic error",
    async (prefix) => {
      const err = await unwrap(wrapFixture(prefix), OTHER_ORG).catch((e: Error) => e);
      expect(err).toBeInstanceOf(PlatformKekError);
      expect((err as Error).message).not.toMatch(NO_LABEL_NAMED);
    },
  );

  it("refuses a tampered wrap and an unknown label", async () => {
    await expect(unwrap(flipLastByte(wrapFixture("chartwarden")))).rejects.toThrow(
      PlatformKekError,
    );
    await expect(unwrap(wrapFixture("otherapp"))).rejects.toThrow(PlatformKekError);
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

  it("opens key material sealed under the chartwarden label", () => {
    expect(
      openPseudonymKeyMaterial(ring, KEK_ID, "epoch-1", fixture("chartwarden")).equals(KEY),
    ).toBe(true);
  });

  it("seals under the chartwarden label (oracle check) and round-trips", () => {
    const { ciphertextB64 } = sealPseudonymKeyMaterial(ring, "epoch-1", KEY);
    expect(openPseudonymKeyMaterial(ring, KEK_ID, "epoch-1", ciphertextB64).equals(KEY)).toBe(true);
    const wrapped = Buffer.from(ciphertextB64, "base64");
    const d = createDecipheriv("aes-256-gcm", KEK, wrapped.subarray(1, 13));
    d.setAAD(Buffer.from(`chartwarden-m35-pseudonym-key:v1:${KEK_ID}:epoch-1`));
    d.setAuthTag(wrapped.subarray(13 + 32));
    expect(Buffer.concat([d.update(wrapped.subarray(13, 45)), d.final()]).equals(KEY)).toBe(true);
  });

  it("FAILS CLOSED on legacy (wardenx) key material, with the same error as any other failure", () => {
    expect(() => openPseudonymKeyMaterial(ring, KEK_ID, "epoch-1", fixture("wardenx"))).toThrow(
      PseudonymKekError,
    );
    try {
      openPseudonymKeyMaterial(ring, KEK_ID, "epoch-1", fixture("wardenx"));
    } catch (error) {
      expect((error as Error).message).not.toMatch(/wardenx|label/i);
    }
  });

  it("fails closed on another epoch", () => {
    expect(() => openPseudonymKeyMaterial(ring, KEK_ID, "epoch-2", fixture("chartwarden"))).toThrow(
      PseudonymKekError,
    );
  });
});

describe("M36 message body labels", () => {
  const v1 = (prefix: string): Buffer => {
    const { nonce, ct, tag } = gcm(hkdf(KEK, `${prefix}-message-dek:${ORG}`), Buffer.from("hello"));
    return Buffer.concat([Buffer.from([1]), nonce, ct, tag]);
  };

  it("opens a v1 (HKDF) body sealed under the chartwarden label", () => {
    expect(openMessageBody(v1("chartwarden"), deriveOrgDek(KEK, ORG))).toBe("hello");
  });

  it("derives the chartwarden DEK for sealing, and a wrong key fails", () => {
    expect(deriveOrgDek(KEK, ORG).equals(hkdf(KEK, `chartwarden-message-dek:${ORG}`))).toBe(true);
    const sealed = sealMessageBody("hello", deriveOrgDek(KEK, ORG));
    expect(() => openMessageBody(sealed, hkdf(KEK, `wardenx-message-dek:${ORG}`))).toThrow();
    expect(() => openMessageBody(sealed, randomBytes(32))).toThrow();
  });

  it("FAILS CLOSED on a legacy (wardenx) v1 body", () => {
    expect(() => openMessageBody(v1("wardenx"), deriveOrgDek(KEK, ORG))).toThrow(
      /unable to authenticate/i,
    );
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

  it("opens a ring (v2) body sealed under the chartwarden AAD label", () => {
    expect(openMessageBodyRing(ringFixture("chartwarden"), RING_KEY, ORG)).toBe("hi ring");
  });

  it("FAILS CLOSED on a legacy (wardenx) ring body", () => {
    expect(() => openMessageBodyRing(ringFixture("wardenx"), RING_KEY, ORG)).toThrow(
      /unable to authenticate/i,
    );
  });

  it("seals the ring body under the chartwarden AAD label (oracle check)", () => {
    const sealed = sealMessageBodyRing("x", { version: "v1", key: RING_KEY }, ORG);
    expect(openMessageBodyRing(sealed, RING_KEY, ORG)).toBe("x");
    const d = createDecipheriv("aes-256-gcm", RING_KEY, sealed.subarray(4, 16));
    d.setAAD(Buffer.from(`chartwarden-message-body:v2:${ORG}:v1`));
    d.setAuthTag(sealed.subarray(sealed.length - 16));
    expect(
      Buffer.concat([d.update(sealed.subarray(16, sealed.length - 16)), d.final()]).toString(),
    ).toBe("x");
  });

  it("fails closed under another tenant or tampered", () => {
    const sealed = ringFixture("chartwarden");
    expect(() => openMessageBodyRing(sealed, RING_KEY, OTHER_ORG)).toThrow();
    expect(() => openMessageBodyRing(flipLastByte(sealed), RING_KEY, ORG)).toThrow();
  });
});

describe("M36 global-search tag labels (one label set)", () => {
  const keys = createLegacyTestSearchKeyProvider(KEK);
  const VERSION = "legacy";
  const BITS = 16;
  const CHANNEL = "cccccccc-0000-4000-8000-000000000001";
  const TERM = "hospice";
  const oracleTags = (prefix: string): number[] => {
    const dek = hkdf(KEK, `chartwarden-message-dek:${ORG}`);
    const search = hkdf(dek, `${prefix}-message-search:${ORG}:${VERSION}`);
    const channel = hkdf(search, `${prefix}-message-search-channel:${VERSION}:t${BITS}:${CHANNEL}`);
    return tagsForTerms(channel, [TERM], BITS);
  };
  const queryTags = async (): Promise<number[]> => {
    const built = await buildVersionQueries(
      keys,
      ORG,
      [{ keyVersion: VERSION, tagBits: BITS, headBuckets: new Set() }],
      [TERM],
      [CHANNEL],
    );
    return [...(built.queries[0]?.channels[0]?.tags ?? [])];
  };

  it("a query probes exactly the chartwarden tags and never the legacy ones", async () => {
    const got = await queryTags();
    expect(got).toEqual([...new Set(oracleTags("chartwarden"))]);
    const legacy = oracleTags("wardenx");
    // tags are 16-bit: assert the legacy derivation differs as a whole, not tag by tag
    expect(got).not.toEqual([...new Set(legacy)]);
  });

  it("the writer's key derivation uses the chartwarden labels", () => {
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
