// GAP-056 - the drilldown audit's filter context is sealed under the per-tenant DEK instead of denying every emit.
import { createDecipheriv, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createDrilldownFilterEncryption } from "../drilldown-crypto";

const ORG = "11111111-1111-4111-8111-111111111111";
const KEY = randomBytes(32);

function open(envelope: string, organizationId: string, key: Buffer): string {
  const [, , nonce, tag, ct] = envelope.split(".");
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(nonce ?? "", "base64url"));
  d.setAAD(Buffer.from(`m33:report_drilldown_audit:query_filters:${organizationId}`, "utf8"));
  d.setAuthTag(Buffer.from(tag ?? "", "base64url"));
  return Buffer.concat([d.update(Buffer.from(ct ?? "", "base64url")), d.final()]).toString("utf8");
}

describe("createDrilldownFilterEncryption", () => {
  const port = createDrilldownFilterEncryption({
    dekForOrg: async () => ({ version: "7", key: KEY }),
  });

  it("seals the plaintext into a versioned envelope that never contains it", async () => {
    const plaintext = JSON.stringify({ patientId: "p-1" });
    const envelope = await port.encryptFilters({ organizationId: ORG, plaintext });
    expect(envelope.startsWith("v1.7.")).toBe(true);
    expect(envelope).not.toContain("p-1");
    expect(open(envelope, ORG, KEY)).toBe(plaintext);
  });

  it("binds the blob to the tenant so another org cannot open it", async () => {
    const envelope = await port.encryptFilters({ organizationId: ORG, plaintext: "x" });
    expect(() => open(envelope, "22222222-2222-4222-8222-222222222222", KEY)).toThrow();
  });

  it("uses a fresh nonce per call", async () => {
    const a = await port.encryptFilters({ organizationId: ORG, plaintext: "x" });
    const b = await port.encryptFilters({ organizationId: ORG, plaintext: "x" });
    expect(a).not.toBe(b);
  });

  it("rejects (fail-closed) when the key provider fails or returns a short key", async () => {
    const broken = createDrilldownFilterEncryption({
      dekForOrg: async () => {
        throw new Error("kms down");
      },
    });
    await expect(broken.encryptFilters({ organizationId: ORG, plaintext: "x" })).rejects.toThrow();
    const short = createDrilldownFilterEncryption({
      dekForOrg: async () => ({ version: "1", key: Buffer.alloc(16) }),
    });
    await expect(short.encryptFilters({ organizationId: ORG, plaintext: "x" })).rejects.toThrow(
      /32 bytes/,
    );
  });
});
