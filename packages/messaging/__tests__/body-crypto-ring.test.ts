// @wardenx/messaging — the ring (v2) message body envelope (M36 WP 2.13 / ADR-0058 P1).
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  bodyEnvelopeScheme,
  deriveOrgDek,
  openMessageBody,
  openMessageBodyRing,
  ringEnvelopeVersion,
  sealMessageBody,
  sealMessageBodyRing,
} from "../src/crypto";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const dek = () => ({ version: "v1", key: randomBytes(32) });

describe("ring body envelope (v2)", () => {
  it("round-trips and records the ring version in the envelope", () => {
    const d = dek();
    const sealed = sealMessageBodyRing("hello ring", d, ORG_A);
    expect(sealed[0]).toBe(2);
    expect(ringEnvelopeVersion(sealed)).toBe("v1");
    expect(openMessageBodyRing(sealed, d.key, ORG_A)).toBe("hello ring");
  });

  it("round-trips an empty body and a multi-byte body", () => {
    const d = dek();
    expect(openMessageBodyRing(sealMessageBodyRing("", d, ORG_A), d.key, ORG_A)).toBe("");
    const s = '{"a":"é漢🙂"}';
    expect(openMessageBodyRing(sealMessageBodyRing(s, d, ORG_A), d.key, ORG_A)).toBe(s);
  });

  it("is bound to the org: the same key under another org id fails (AAD)", () => {
    const d = dek();
    const sealed = sealMessageBodyRing("org A only", d, ORG_A);
    expect(() => openMessageBodyRing(sealed, d.key, ORG_B)).toThrow();
  });

  it("is bound to the version label: a relabelled envelope fails (AAD)", () => {
    const d = dek();
    const sealed = sealMessageBodyRing("x", d, ORG_A);
    const forged = Buffer.from(sealed);
    forged.write("v2", 2, "ascii");
    expect(() => openMessageBodyRing(forged, d.key, ORG_A)).toThrow();
  });

  it("rejects tamper, truncation, a wrong key and a bad version label", () => {
    const d = dek();
    const sealed = sealMessageBodyRing("integrity", d, ORG_A);
    const tampered = Buffer.from(sealed);
    tampered[tampered.length - 20] = (tampered[tampered.length - 20] ?? 0) ^ 1;
    expect(() => openMessageBodyRing(tampered, d.key, ORG_A)).toThrow();
    expect(() => openMessageBodyRing(sealed.subarray(0, 10), d.key, ORG_A)).toThrow(/malformed/);
    expect(() => openMessageBodyRing(sealed, randomBytes(32), ORG_A)).toThrow();
    expect(() => sealMessageBodyRing("x", { version: "bad label!", key: d.key }, ORG_A)).toThrow(
      /version/,
    );
    expect(() => sealMessageBodyRing("x", { version: "v1", key: randomBytes(16) }, ORG_A)).toThrow(
      /32/,
    );
  });

  it("classifies envelopes by scheme without decrypting", () => {
    const kek = randomBytes(32);
    const legacy = sealMessageBody("old", deriveOrgDek(kek, ORG_A));
    expect(bodyEnvelopeScheme(legacy)).toBe("legacy");
    expect(bodyEnvelopeScheme(sealMessageBodyRing("new", dek(), ORG_A))).toBe("ring");
    expect(bodyEnvelopeScheme(Buffer.alloc(0))).toBe("erased");
    expect(bodyEnvelopeScheme(Buffer.from([9, 1, 2]))).toBe("unknown");
  });

  it("the legacy opener refuses a ring envelope (no silent cross-scheme open)", () => {
    const d = dek();
    expect(() => openMessageBody(sealMessageBodyRing("n", d, ORG_A), d.key)).toThrow(/version/);
  });
});
