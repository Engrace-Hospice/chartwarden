// An INDEPENDENT oracle for the crypto context labels (ChartWarden rename, release 2): every seal and open here is built from LITERAL
// label strings and node:crypto, with no import from the modules under test, so a test can say "this stored value opens under the
// chartwarden label and NOT under the wardenx one" without trusting the code that wrote it.
//   prefix "wardenx"      = the legacy label (what production holds before the backfill);
//   prefix "chartwarden"  = the current label (what the writers emit since release 2).
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";

export type LabelPrefix = "wardenx" | "chartwarden";

export const hkdf = (ikm: Buffer, info: string): Buffer =>
  Buffer.from(hkdfSync("sha256", ikm, Buffer.alloc(0), info, 32));

function seal(key: Buffer, plaintext: Buffer, aad?: string, tagLength = 16) {
  const nonce = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: tagLength });
  if (aad !== undefined) c.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([c.update(plaintext), c.final()]);
  return { nonce, ct, tag: c.getAuthTag() };
}

function open(key: Buffer, nonce: Buffer, ct: Buffer, tag: Buffer, aad?: string): Buffer {
  const d = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
  if (aad !== undefined) d.setAAD(Buffer.from(aad, "utf8"));
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}

export interface MacContext {
  readonly providerEntityId: string;
  readonly macJurisdiction: string;
}

export function oracle(prefix: LabelPrefix) {
  return {
    // M34: version(1) | nonce(12) | ct(32) | tag(16); AAD binds the KEK id and the tenant.
    wrapDek(kek: Buffer, kekId: string, org: string, dek: Buffer): Buffer {
      const { nonce, ct, tag } = seal(kek, dek, `${prefix}-m34-tenant-dek:v1:${kekId}:${org}`);
      return Buffer.concat([Buffer.from([1]), nonce, ct, tag]);
    },
    unwrapDek(kek: Buffer, kekId: string, org: string, wrapped: Buffer): Buffer {
      return open(
        kek,
        wrapped.subarray(1, 13),
        wrapped.subarray(13, 45),
        wrapped.subarray(45),
        `${prefix}-m34-tenant-dek:v1:${kekId}:${org}`,
      );
    },

    // M5: 0x01 | verLen | version | nonce | tag | ct.
    identifier(
      dek: Buffer,
      version: string,
      org: string,
      id: string,
      kind: string,
      plaintext: string,
    ): Buffer {
      const { nonce, ct, tag } = seal(
        dek,
        Buffer.from(plaintext),
        `${prefix}:m5:patient_identifier:value_encrypted:v1:${org}:${id}:${kind}`,
      );
      return Buffer.concat([
        Buffer.from([1, Buffer.byteLength(version)]),
        Buffer.from(version),
        nonce,
        tag,
        ct,
      ]);
    },
    openIdentifier(dek: Buffer, org: string, id: string, kind: string, envelope: Buffer): string {
      const vLen = envelope[1] as number;
      const n = 2 + vLen;
      return open(
        dek,
        envelope.subarray(n, n + 12),
        envelope.subarray(n + 28),
        envelope.subarray(n + 12, n + 28),
        `${prefix}:m5:patient_identifier:value_encrypted:v1:${org}:${id}:${kind}`,
      ).toString();
    },
    ssnIndex(dek: Buffer, org: string, digits: string): Buffer {
      return createHmac("sha256", hkdf(dek, `${prefix}:m5:ssn-blind-index:v1:${org}`))
        .update(`ssn:${digits}`)
        .digest();
    },

    // M23: base64( 2 | nonce | ct | tag ); AAD = prefix-m23-mac-credential:v2 | org | provider entity | jurisdiction.
    macSecret(kek: Buffer, org: string, ctx: MacContext, secret: string): string {
      const { nonce, ct, tag } = seal(
        hkdf(kek, `${prefix}-m23-mac-credential-dek:${org.toLowerCase()}`),
        Buffer.from(secret),
        [
          `${prefix}-m23-mac-credential:v2`,
          org.toLowerCase(),
          ctx.providerEntityId.toLowerCase(),
          ctx.macJurisdiction,
        ].join("|"),
      );
      return Buffer.concat([Buffer.from([2]), nonce, ct, tag]).toString("base64");
    },
    openMacSecret(kek: Buffer, org: string, ctx: MacContext, sealed: string): string {
      const raw = Buffer.from(sealed, "base64");
      return open(
        hkdf(kek, `${prefix}-m23-mac-credential-dek:${org.toLowerCase()}`),
        raw.subarray(1, 13),
        raw.subarray(13, raw.length - 16),
        raw.subarray(raw.length - 16),
        [
          `${prefix}-m23-mac-credential:v2`,
          org.toLowerCase(),
          ctx.providerEntityId.toLowerCase(),
          ctx.macJurisdiction,
        ].join("|"),
      ).toString();
    },

    // M24: base64( 1 | nonce | ct | tag ), no AAD; the DEK label is the only binding.
    credential(kek: Buffer, org: string, secret: string): string {
      const { nonce, ct, tag } = seal(
        hkdf(kek, `${prefix}-m24-trading-partner-dek:${org}`),
        Buffer.from(secret),
      );
      return Buffer.concat([Buffer.from([1]), nonce, ct, tag]).toString("base64");
    },
    openCredential(kek: Buffer, org: string, sealed: string): string {
      const raw = Buffer.from(sealed, "base64");
      return open(
        hkdf(kek, `${prefix}-m24-trading-partner-dek:${org}`),
        raw.subarray(1, 13),
        raw.subarray(13, raw.length - 16),
        raw.subarray(raw.length - 16),
      ).toString();
    },

    // M35: base64( 1 | nonce | ct(32) | tag ); AAD binds the KEK id and the key epoch.
    pseudonym(kek: Buffer, kekId: string, epoch: string, key: Buffer): string {
      const { nonce, ct, tag } = seal(kek, key, `${prefix}-m35-pseudonym-key:v1:${kekId}:${epoch}`);
      return Buffer.concat([Buffer.from([1]), nonce, ct, tag]).toString("base64");
    },
    openPseudonym(kek: Buffer, kekId: string, epoch: string, sealed: string): Buffer {
      const raw = Buffer.from(sealed, "base64");
      return open(
        kek,
        raw.subarray(1, 13),
        raw.subarray(13, 45),
        raw.subarray(45),
        `${prefix}-m35-pseudonym-key:v1:${kekId}:${epoch}`,
      );
    },

    // M36 body v1: 1 | nonce | ct | tag under hkdf(messaging KEK, prefix-message-dek:org).
    bodyV1(kek: Buffer, org: string, text: string): Buffer {
      const { nonce, ct, tag } = seal(hkdf(kek, `${prefix}-message-dek:${org}`), Buffer.from(text));
      return Buffer.concat([Buffer.from([1]), nonce, ct, tag]);
    },
    openBodyV1(kek: Buffer, org: string, envelope: Buffer): string {
      return open(
        hkdf(kek, `${prefix}-message-dek:${org}`),
        envelope.subarray(1, 13),
        envelope.subarray(13, envelope.length - 16),
        envelope.subarray(envelope.length - 16),
      ).toString();
    },
    // M36 body v2: 2 | labelLen | label | nonce | ct | tag; AAD = prefix-message-body:v2:org:label.
    bodyV2(ringKey: Buffer, org: string, ringVersion: string, text: string): Buffer {
      const { nonce, ct, tag } = seal(
        ringKey,
        Buffer.from(text),
        `${prefix}-message-body:v2:${org}:${ringVersion}`,
      );
      return Buffer.concat([
        Buffer.from([2, Buffer.byteLength(ringVersion)]),
        Buffer.from(ringVersion),
        nonce,
        ct,
        tag,
      ]);
    },
    openBodyV2(ringKey: Buffer, org: string, envelope: Buffer): string {
      const len = envelope[1] as number;
      const version = envelope.subarray(2, 2 + len).toString();
      const n = 2 + len;
      return open(
        ringKey,
        envelope.subarray(n, n + 12),
        envelope.subarray(n + 12, envelope.length - 16),
        envelope.subarray(envelope.length - 16),
        `${prefix}-message-body:v2:${org}:${version}`,
      ).toString();
    },

    // M36 search: K_search = hkdf(ringDek, prefix-message-search:org:version); K_ch = hkdf(K_search, prefix-message-search-channel:...).
    searchKey(ringDek: Buffer, org: string, version: string): Buffer {
      return hkdf(ringDek, `${prefix}-message-search:${org}:${version}`);
    },
    channelKey(searchKey: Buffer, version: string, bits: number, channelId: string): Buffer {
      return hkdf(searchKey, `${prefix}-message-search-channel:${version}:t${bits}:${channelId}`);
    },
    /** First 8 bytes of HMAC(K_search, "n\0" + token), hex: the name-exclusion digest of one token. */
    nameDigest(searchKey: Buffer, token: string): string {
      return createHmac("sha256", searchKey)
        .update(`n\u0000${token}`)
        .digest()
        .subarray(0, 8)
        .toString("hex");
    },
  };
}

export const legacyOracle = oracle("wardenx");
export const currentOracle = oracle("chartwarden");

/** True when `fn` throws (an authentication failure under that label). */
export function fails(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}
