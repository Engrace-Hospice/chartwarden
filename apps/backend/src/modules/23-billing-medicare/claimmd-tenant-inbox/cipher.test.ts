import { describe, expect, it, vi } from "vitest";
import {
  createTenantClaimMdInboxCipher,
  decodeTenantClaimMdSource,
  encodeTenantClaimMdSource,
} from "./cipher";

const identity = {
  organizationId: "00000000-0000-4000-8000-000000000001",
  accountId: "00000000-0000-4000-8000-000000000002",
  batchId: "00000000-0000-4000-8000-000000000003",
  usage: "test" as const,
  afterCursor: "123",
};

describe("tenant Claim.MD inbox encryption", () => {
  it.each([
    ["json", '{"claim":[{"pcn":"synthetic"}]}'],
    ["xml", '<response><claim pcn="synthetic" /></response>'],
  ] as const)(
    "preserves exact %s source under tenant DEK and identity AAD",
    async (sourceFormat, rawPayload) => {
      const key = Buffer.alloc(32, 9);
      const cipher = createTenantClaimMdInboxCipher({
        dekForOrg: vi.fn(async () => ({ version: "dek-1", key })),
        dekForOrgVersion: vi.fn(async (_org, version) => ({ version, key })),
      });
      const sealed = await cipher.seal({
        ...identity,
        plaintext: encodeTenantClaimMdSource({ sourceFormat, rawPayload }),
      });
      expect(sealed.ciphertext.toString("utf8")).not.toContain(rawPayload);
      const opened = await cipher.open({
        ...identity,
        ciphertext: sealed.ciphertext,
        keyVersion: sealed.keyVersion,
      });
      expect(decodeTenantClaimMdSource(opened)).toEqual({ sourceFormat, rawPayload });
      await expect(
        cipher.open({
          ...identity,
          organizationId: "00000000-0000-4000-8000-000000000099",
          ciphertext: sealed.ciphertext,
          keyVersion: sealed.keyVersion,
        }),
      ).rejects.toThrow();
      await expect(
        cipher.open({
          ...identity,
          accountId: "00000000-0000-4000-8000-000000000099",
          ciphertext: sealed.ciphertext,
          keyVersion: sealed.keyVersion,
        }),
      ).rejects.toThrow();
      await expect(
        cipher.open({
          ...identity,
          afterCursor: "124",
          ciphertext: sealed.ciphertext,
          keyVersion: sealed.keyVersion,
        }),
      ).rejects.toThrow();
    },
  );

  it("uses the archived key version after rotation and fails closed when that key is unavailable", async () => {
    const oldKey = Buffer.alloc(32, 1);
    const currentKey = Buffer.alloc(32, 2);
    const keys = {
      dekForOrg: async () => ({ version: "dek-2", key: currentKey }),
      dekForOrgVersion: async (_org: string, version: string) => ({
        version,
        key: version === "dek-1" ? oldKey : currentKey,
      }),
    };
    const beforeRotation = createTenantClaimMdInboxCipher({
      dekForOrg: async () => ({ version: "dek-1", key: oldKey }),
      dekForOrgVersion: keys.dekForOrgVersion,
    });
    const sealed = await beforeRotation.seal({ ...identity, plaintext: "exact source" });
    const afterRotation = createTenantClaimMdInboxCipher(keys);
    await expect(
      afterRotation.open({
        ...identity,
        ciphertext: sealed.ciphertext,
        keyVersion: sealed.keyVersion,
      }),
    ).resolves.toBe("exact source");
    const missingOldKey = createTenantClaimMdInboxCipher({
      ...keys,
      dekForOrgVersion: async () => {
        throw new Error("key unavailable");
      },
    });
    await expect(
      missingOldKey.open({
        ...identity,
        ciphertext: sealed.ciphertext,
        keyVersion: sealed.keyVersion,
      }),
    ).rejects.toThrow("key unavailable");
  });

  it("rejects tampered ciphertext and unsupported envelope versions", async () => {
    const key = Buffer.alloc(32, 3);
    const cipher = createTenantClaimMdInboxCipher({
      dekForOrg: async () => ({ version: "v1", key }),
      dekForOrgVersion: async () => ({ version: "v1", key }),
    });
    const sealed = await cipher.seal({ ...identity, plaintext: "body" });
    const corrupt = Buffer.from(sealed.ciphertext);
    corrupt[corrupt.length - 1] = (corrupt.at(-1) ?? 0) ^ 0xff;
    await expect(
      cipher.open({ ...identity, ciphertext: corrupt, keyVersion: sealed.keyVersion }),
    ).rejects.toThrow();
    expect(() =>
      decodeTenantClaimMdSource('{"version":2,"sourceFormat":"json","rawPayload":"x"}'),
    ).toThrow("CLAIMMD_RESPONSE_ENVELOPE_INVALID");
  });
});
