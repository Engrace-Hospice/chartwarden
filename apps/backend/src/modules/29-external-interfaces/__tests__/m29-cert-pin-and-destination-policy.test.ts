// F-181 (#248) — the canonical channelCertPin convention and the outbound destination policy, as pure units.
// Real certificates come from the system `openssl` (the F-175 transport suite's precedent — no new dependency).
import { execFileSync } from "node:child_process";
import { X509Certificate, createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { CertPinError, certPinFromDer, certPinFromPem, derFromPem, normalizeCertPin } from "../feed/cert-pin";
import {
  checkProtocol,
  classifyAddress,
  classifyHostname,
  isProductionEnv,
  resolveDestinationPolicy,
} from "../outbound/destination-policy";
import { decidePermanentFailure } from "../outbound/retry-policy";

let pemA = "";
let pemB = "";

function makeCert(cn: string): string {
  const dir = mkdtempSync(join(tmpdir(), "m29-cert-pin-"));
  try {
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem"),
      "-days", "1", "-subj", `/CN=${cn}`,
    ]);
    return readFileSync(join(dir, "c.pem"), "utf8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

beforeAll(() => {
  pemA = makeCert("f178-a");
  pemB = makeCert("f178-b");
});

describe("certPin — one canonical, tool-independent convention (sha256 of the DER)", () => {
  it("equals sha256 of the certificate's DER bytes", () => {
    const der = new X509Certificate(pemA).raw;
    expect(certPinFromPem(pemA)).toBe(createHash("sha256").update(der).digest("hex"));
    expect(certPinFromDer(der)).toBe(certPinFromPem(pemA));
    expect(certPinFromPem(pemA)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is byte-stable across line-wrap width, CRLF, blank lines and surrounding text", () => {
    const b64 = new X509Certificate(pemA).raw.toString("base64");
    const variants = [
      pemA,
      `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----`, // one long line
      `-----BEGIN CERTIFICATE-----\r\n${b64.match(/.{1,64}/g)!.join("\r\n")}\r\n-----END CERTIFICATE-----\r\n`, // CRLF, 64-col
      `  \n\nsubject: whatever\n-----BEGIN CERTIFICATE-----\n${b64.match(/.{1,30}/g)!.join("\n \n")}\n-----END CERTIFICATE-----\ntrailing junk`,
    ];
    const pins = variants.map(certPinFromPem);
    expect(new Set(pins).size).toBe(1);
    // …whereas a hash of the PEM TEXT (the old schema comment) differs per spelling — why it cannot be the pin.
    const textHashes = variants.map((v) => createHash("sha256").update(v).digest("hex"));
    expect(new Set(textHashes).size).toBe(variants.length);
  });

  it("different certificates give different pins", () => {
    expect(certPinFromPem(pemA)).not.toBe(certPinFromPem(pemB));
  });

  it("uses the FIRST certificate of a bundle", () => {
    expect(certPinFromPem(`${pemA}\n${pemB}`)).toBe(certPinFromPem(pemA));
  });

  it("refuses anything that is not a parseable certificate — a key, garbage, empty, bad base64", () => {
    for (const bad of [
      "",
      "not a pem",
      "-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----",
      "-----BEGIN CERTIFICATE-----\n\n-----END CERTIFICATE-----",
      "-----BEGIN CERTIFICATE-----\n@@@not-base64@@@\n-----END CERTIFICATE-----",
      "-----BEGIN CERTIFICATE-----\nQUJDRA==\n-----END CERTIFICATE-----", // valid base64, not a cert
    ]) {
      expect(() => derFromPem(bad), JSON.stringify(bad)).toThrow(CertPinError);
    }
  });

  it("normalizeCertPin accepts a 64-hex pin (any case, padded) or a PEM, and refuses the rest", () => {
    const pin = certPinFromPem(pemA);
    expect(normalizeCertPin(pin.toUpperCase())).toBe(pin);
    expect(normalizeCertPin(`  ${pin}\n`)).toBe(pin);
    expect(normalizeCertPin(pemA)).toBe(pin);
    expect(() => normalizeCertPin("abc123")).toThrow(CertPinError);
    expect(() => normalizeCertPin("z".repeat(64))).toThrow(CertPinError);
  });
});

describe("destination policy", () => {
  const prod = resolveDestinationPolicy({ NODE_ENV: "production" });
  const dev = resolveDestinationPolicy({ NODE_ENV: "development" });

  it("production is decided ONLY by NODE_ENV=production", () => {
    expect(isProductionEnv({ NODE_ENV: "production" })).toBe(true);
    expect(isProductionEnv({ NODE_ENV: "staging" })).toBe(false);
    expect(isProductionEnv({})).toBe(false);
  });

  it("mllp_plain needs BOTH non-production AND the explicit opt-in — and production ignores the opt-in", () => {
    expect(resolveDestinationPolicy({ NODE_ENV: "development" }).allowPlain).toBe(false); // default: refuse
    expect(resolveDestinationPolicy({ NODE_ENV: "development", M29_ALLOW_MLLP_PLAIN: "true" }).allowPlain).toBe(true);
    expect(resolveDestinationPolicy({ NODE_ENV: "development", M29_ALLOW_MLLP_PLAIN: "1" }).allowPlain).toBe(false);
    expect(resolveDestinationPolicy({ NODE_ENV: "production", M29_ALLOW_MLLP_PLAIN: "true" }).allowPlain).toBe(false);
    expect(checkProtocol("mllp_plain", prod)).toBe("plain_protocol_refused");
    expect(checkProtocol("mllp_plain", dev)).toBe("plain_protocol_refused");
    expect(checkProtocol("mllp_tls", prod)).toBeNull();
    expect(checkProtocol("mllp_plain", { allowPlain: true, allowLoopback: true })).toBeNull();
  });

  it("link-local and metadata destinations are refused in EVERY environment", () => {
    for (const policy of [prod, dev]) {
      expect(classifyAddress("169.254.169.254", policy)).toBe("destination_link_local");
      expect(classifyAddress("169.254.0.1", policy)).toBe("destination_link_local");
      expect(classifyAddress("fe80::1", policy)).toBe("destination_link_local");
      expect(classifyAddress("febf::1", policy)).toBe("destination_link_local");
      expect(classifyAddress("::ffff:169.254.169.254", policy)).toBe("destination_link_local");
      expect(classifyAddress("::ffff:a9fe:a9fe", policy)).toBe("destination_link_local");
      expect(classifyAddress("100.100.100.200", policy)).toBe("destination_metadata_host");
      expect(classifyAddress("fd00:ec2::254", policy)).toBe("destination_metadata_host");
      expect(classifyHostname("metadata.google.internal", policy)).toBe("destination_metadata_host");
      expect(classifyHostname("Metadata.Google.Internal.", policy)).toBe("destination_metadata_host");
      expect(classifyHostname("169.254.169.254", policy)).toBe("destination_link_local");
    }
  });

  it("loopback / unspecified are refused in production only", () => {
    for (const ip of ["127.0.0.1", "127.9.9.9", "::1", "::ffff:127.0.0.1"]) {
      expect(classifyAddress(ip, prod), ip).toBe("destination_loopback");
      expect(classifyAddress(ip, dev), ip).toBeNull();
    }
    expect(classifyAddress("0.0.0.0", prod)).toBe("destination_unspecified");
    expect(classifyAddress("::", prod)).toBe("destination_unspecified");
    expect(classifyAddress("0.0.0.0", dev)).toBeNull();
    expect(classifyHostname("localhost", prod)).toBe("destination_loopback");
    expect(classifyHostname("foo.localhost", prod)).toBe("destination_loopback");
    expect(classifyHostname("localhost", dev)).toBeNull();
  });

  it("multicast is refused; private (RFC1918 / ULA) and public addresses are NOT — a hospital receiver lives on a VPN", () => {
    expect(classifyAddress("224.0.0.1", dev)).toBe("destination_multicast");
    expect(classifyAddress("ff02::1", dev)).toBe("destination_multicast");
    for (const ok of ["10.1.2.3", "172.16.0.5", "192.168.1.9", "8.8.8.8", "fd12:3456::1", "2606:4700::1111"]) {
      expect(classifyAddress(ok, prod), ok).toBeNull();
    }
    expect(classifyHostname("lab.example.org", prod)).toBeNull();
  });
});

describe("decidePermanentFailure — a refusal retrying cannot fix goes straight to the terminal DLQ", () => {
  const input = {
    outbound: { id: "o1", feedId: "f1", organizationId: "org", sourceAggregateId: "ord1", retryCount: 0 },
    now: new Date("2026-09-29T00:00:00Z"),
    lastError: "plain_protocol_refused",
  };
  it("emits the standard transmission_failed shape with the TRUE attempt count and no next retry", () => {
    const d = decidePermanentFailure(input);
    expect(d.kind).toBe("dlq");
    expect(d.statusUpdate).toEqual({ status: "dlq", retryCount: 1, nextRetryAt: null });
    expect(d.event).toEqual({
      name: "m29.lab_order.transmission_failed",
      payload: {
        orderId: "ord1", organizationId: "org", feedId: "f1", outboundMessageId: "o1",
        reason: "dlq_exhausted", detail: "plain_protocol_refused", attemptCount: 1,
      },
    });
    expect(d.alert.severity).toBe("HIGH");
    expect(d.audit.kind).toBe("hl7.outbound.dlq");
  });
  it("counts prior attempts when a sweep retry hits a refusal (config changed between attempts)", () => {
    expect(decidePermanentFailure({ ...input, outbound: { ...input.outbound, retryCount: 2 } }).event.payload.attemptCount).toBe(3);
  });
});
