/**
 * GAP-086 — the pure pieces of the M29 listener process + parse worker (the DB / socket behavior is proven in
 * `apps/backend/__tests__/gap-086-m29-listener.live.test.ts`).
 */
import { afterAll, describe, expect, it } from "vitest";

import {
  createInboundCipher,
  isSealedEnvelope,
} from "../src/modules/29-external-interfaces/inbound/inbound-crypto";
import { redactObxValues } from "../src/modules/29-external-interfaces/inbound/parse-worker";
import {
  CredentialLoadError,
  parseCredentialBundle,
} from "../src/modules/29-external-interfaces/listener/credential-loader";
import {
  inboundIdempotencyKey,
  messageTypeOf,
  summarizeInboundSegments,
} from "../src/modules/29-external-interfaces/listener/ingest-sink";
import {
  alertEmitInput,
  hl7Timestamp,
} from "../src/modules/29-external-interfaces/listener/process";
import { createTlsFixtures, hasOpenssl } from "./_m29-tls-fixtures";

const keys = {
  dekForOrg: async () => ({ version: "v7", key: Buffer.alloc(32, 3) }),
  dekForOrgVersion: async (_o: string, version: string) => ({ version, key: Buffer.alloc(32, 3) }),
};

describe("inbound cipher", () => {
  const cipher = createInboundCipher(keys);

  it("round-trips and embeds the DEK version", async () => {
    const sealed = await cipher.encrypt("org-a", "hl7_message_inbound.payload", "MSH|^~\\&|X");
    expect(sealed.split(".")[1]).toBe("v7");
    expect(isSealedEnvelope(sealed)).toBe(true);
    expect(sealed).not.toContain("MSH");
    expect(await cipher.decrypt("org-a", "hl7_message_inbound.payload", sealed)).toBe(
      "MSH|^~\\&|X",
    );
  });

  it("binds tenant and column: another org or another column cannot open it", async () => {
    const sealed = await cipher.encrypt("org-a", "hl7_message_inbound.payload", "secret");
    await expect(cipher.decrypt("org-b", "hl7_message_inbound.payload", sealed)).rejects.toThrow();
    await expect(
      cipher.decrypt("org-a", "hl7_message_inbound.parsed_segments", sealed),
    ).rejects.toThrow();
  });

  it("does not mistake a legacy sha256 digest for an envelope", async () => {
    expect(isSealedEnvelope("a".repeat(64))).toBe(false);
    await expect(
      createInboundCipher(keys).decrypt("o", "hl7_message_inbound.payload", "a".repeat(64)),
    ).rejects.toThrow(/malformed/);
  });

  it("refuses a DEK that is not 32 bytes", async () => {
    const short = createInboundCipher({
      ...keys,
      dekForOrg: async () => ({ version: "v1", key: Buffer.alloc(16) }),
    });
    await expect(short.encrypt("o", "hl7_message_inbound.payload", "x")).rejects.toThrow(
      /32 bytes/,
    );
  });
});

describe("ingest helpers", () => {
  const payload = "MSH|^~\\&|A|B\rPID|1||X\r\rOBX|1|NM|a||5\n";
  it("summarises segment SHAPE only (no field values)", () => {
    const summary = summarizeInboundSegments(payload);
    expect(summary.segments.map((s) => s.name)).toEqual(["MSH", "PID", "OBX"]);
    expect(JSON.stringify(summary)).not.toContain("5");
  });
  it("recombines MSH-9 and keys idempotency on feed + sender + control id", () => {
    const env = {
      messageControlId: "C1",
      messageCode: "ADT",
      triggerEvent: "A01",
      sendingApplication: "A",
      sendingFacility: "F",
      receivingApplication: "",
      receivingFacility: "",
    };
    expect(messageTypeOf(env)).toBe("ADT^A01");
    expect(messageTypeOf({ ...env, triggerEvent: "" })).toBe("ADT");
    expect(inboundIdempotencyKey("feed1", env)).toMatch(/^[0-9a-f]{64}$/);
    expect(inboundIdempotencyKey("feed1", env)).not.toBe(inboundIdempotencyKey("feed2", env));
    expect(inboundIdempotencyKey("feed1", env)).not.toBe(
      inboundIdempotencyKey("feed1", { ...env, sendingFacility: "G" }),
    );
  });
});

describe("redactObxValues", () => {
  it("replaces OBX-5 only, leaving every other segment and field intact", () => {
    const wire =
      "MSH|^~\\&|A|B\rPID|1||X\rOBX|1|NM|3426-4^T^LN||POSITIVE|mg|0-1|H|||F\rOBX|2|ST|x||second|\r";
    const out = redactObxValues(wire);
    expect(out).not.toContain("POSITIVE");
    expect(out).not.toContain("second");
    expect(out).toContain("OBX|1|NM|3426-4^T^LN||[REDACTED_SUD]|mg|0-1|H|||F");
    expect(out).toContain("PID|1||X");
    expect(out.split("\r")).toHaveLength(wire.split("\r").length);
  });
});

describe("listener process helpers", () => {
  it("formats an HL7 UTC timestamp", () => {
    expect(hl7Timestamp(new Date("2026-08-01T12:03:04.567Z"))).toBe("20260801120304");
  });

  it("routes alerts to the seeded rules and windows the correlation id per day", () => {
    const base = {
      severity: "critical" as const,
      channel: "compliance" as const,
      feedId: "f",
      organizationId: "o",
      title: "t",
      body: "b",
    };
    const day1 = new Date("2026-08-01T01:00:00Z");
    const day1Late = new Date("2026-08-01T23:00:00Z");
    const day2 = new Date("2026-08-02T01:00:00Z");
    const a = alertEmitInput({ ...base, kind: "external_feed.baa_expired" }, day1);
    expect(a.eventType).toBe("external_feed.baa_expired");
    expect(a.severity).toBe("critical");
    expect(
      alertEmitInput({ ...base, kind: "external_feed.baa_expired" }, day1Late).correlationId,
    ).toBe(a.correlationId);
    expect(
      alertEmitInput({ ...base, kind: "external_feed.baa_expired" }, day2).correlationId,
    ).not.toBe(a.correlationId);
    expect(alertEmitInput(base, day1).eventType).toBe("external_feed.listener_blocked");
    expect(Object.keys(a.payload).sort()).toEqual(["detail", "feedId"]);
  });
});

describe.skipIf(!hasOpenssl())("parseCredentialBundle", () => {
  const fx = createTlsFixtures();
  afterAll(() => fx.dispose());
  const code = (fn: () => unknown): string | undefined => {
    try {
      fn();
    } catch (e) {
      return e instanceof CredentialLoadError ? e.code : "other";
    }
    return undefined;
  };

  it("accepts a valid bundle", () => {
    expect(parseCredentialBundle(fx.bundleJson).serverCertPem).toBe(fx.serverCertPem);
  });
  it("rejects a key that does not belong to the certificate", () => {
    const bad = JSON.stringify({ ...JSON.parse(fx.bundleJson), serverKeyPem: fx.clientKeyPem });
    expect(code(() => parseCredentialBundle(bad))).toBe("credential_bundle_invalid");
  });
  it("rejects missing fields, non-JSON, and non-certificates", () => {
    expect(code(() => parseCredentialBundle("{"))).toBe("credential_bundle_invalid");
    expect(code(() => parseCredentialBundle(JSON.stringify({ serverCertPem: "x" })))).toBe(
      "credential_bundle_invalid",
    );
    const junk = JSON.stringify({
      ...JSON.parse(fx.bundleJson),
      expectedClientCaPem: "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----",
    });
    expect(code(() => parseCredentialBundle(junk))).toBe("credential_bundle_invalid");
  });
  it("rejects a certificate outside its validity window", () => {
    expect(code(() => parseCredentialBundle(fx.bundleJson, new Date("2100-01-01")))).toBe(
      "credential_bundle_invalid",
    );
  });
  it("never echoes PEM material in its error", () => {
    const bad = JSON.stringify({ ...JSON.parse(fx.bundleJson), serverKeyPem: fx.clientKeyPem });
    try {
      parseCredentialBundle(bad);
    } catch (e) {
      expect(String((e as Error).message)).not.toContain("BEGIN");
    }
  });
});
