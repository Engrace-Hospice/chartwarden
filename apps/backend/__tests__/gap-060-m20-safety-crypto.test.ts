// GAP-060 — the M20 DEK envelope (cipher + decipher) and the §4.5 SOS recipient counter.
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createSafetyCiphers } from "../src/modules/20-field-safety/safety-crypto";
import { createSosRecipientCounter } from "../src/modules/20-field-safety/sos-recipient-count";

const KEYS = new Map<string, Buffer>([
  ["v1", randomBytes(32)],
  ["v2", randomBytes(32)],
]);

function keyProvider(active: string) {
  return {
    async dekForOrg(_org: string) {
      return { version: active, key: KEYS.get(active) as Buffer };
    },
    async dekForOrgVersion(_org: string, version: string) {
      const key = KEYS.get(version);
      if (key === undefined) throw new Error("no such version");
      return { version, key };
    },
  };
}

describe("createSafetyCiphers", () => {
  it("turns a key-resolve failure into a typed 503 instead of a bare Error (#596 F-039)", async () => {
    const { cipher } = createSafetyCiphers({
      ...keyProvider("v1"),
      async dekForOrg() {
        throw new Error("TenantKeyMissing: no tenant key ring for org org-a");
      },
    });
    const err = await cipher.encrypt({ organizationId: "org-a", plaintext: "x" }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "SAFETY_CIPHER_UNBOUND", statusCode: 503 });
    expect((err as Error).message).not.toContain("org-a");
  });

  it("round-trips plaintext through bytea-shaped ciphertext that is not the plaintext", async () => {
    const { cipher, decipher } = createSafetyCiphers(keyProvider("v1"));
    const sealed = await cipher.encrypt({ organizationId: "org-a", plaintext: "narrative" });
    expect(Buffer.isBuffer(sealed)).toBe(true);
    expect(sealed.toString("utf8")).not.toContain("narrative");
    expect(await decipher.decrypt({ organizationId: "org-a", cipher: sealed })).toBe("narrative");
  });

  it("refuses to open a blob under another tenant (AAD binds the org)", async () => {
    const { cipher, decipher } = createSafetyCiphers(keyProvider("v1"));
    const sealed = await cipher.encrypt({ organizationId: "org-a", plaintext: "x" });
    await expect(decipher.decrypt({ organizationId: "org-b", cipher: sealed })).rejects.toThrow();
  });

  it("opens a row sealed under a previous DEK version after rotation", async () => {
    const old = createSafetyCiphers(keyProvider("v1"));
    const sealed = await old.cipher.encrypt({ organizationId: "org-a", plaintext: "old" });
    const rotated = createSafetyCiphers(keyProvider("v2"));
    expect(await rotated.decipher.decrypt({ organizationId: "org-a", cipher: sealed })).toBe("old");
  });

  it("throws on a malformed envelope rather than returning bytes as text", async () => {
    const { decipher } = createSafetyCiphers(keyProvider("v1"));
    await expect(
      decipher.decrypt({
        organizationId: "org-a",
        cipher: Buffer.from("m20:no-coordinate-consent"),
      }),
    ).rejects.toThrow();
  });

  it("rejects a DEK that is not 32 bytes", async () => {
    const bad = {
      ...keyProvider("v1"),
      async dekForOrg() {
        return { version: "v1", key: Buffer.alloc(16) };
      },
    };
    const { cipher } = createSafetyCiphers(bad);
    await expect(cipher.encrypt({ organizationId: "o", plaintext: "x" })).rejects.toThrow();
  });
});

describe("createSosRecipientCounter", () => {
  const input = {
    organizationId: "org-a",
    clinicianMembershipId: "m-1",
    providerEntityId: "pe-1",
    atIso: "2026-10-06T10:00:00.000Z",
  };

  it("counts distinct supervisors, honouring vacation forwarding", async () => {
    const count = createSosRecipientCounter({
      async supervisorsForClinician() {
        return [
          {
            supervisorMembershipId: "s1",
            isVacationForwarded: false,
            vacationForwardToMembershipId: null,
          },
          {
            supervisorMembershipId: "s2",
            isVacationForwarded: true,
            vacationForwardToMembershipId: "s1",
          },
          {
            supervisorMembershipId: "s3",
            isVacationForwarded: true,
            vacationForwardToMembershipId: "s4",
          },
        ] as never;
      },
    });
    expect(await count(input)).toBe(2);
  });

  it("answers null (not 0) when no supervisor resolves, so the client falls back to tel:", async () => {
    const count = createSosRecipientCounter({
      async supervisorsForClinician() {
        return [];
      },
    });
    expect(await count(input)).toBeNull();
  });

  it("propagates an unreadable registry so the write service maps it to null", async () => {
    const count = createSosRecipientCounter({
      async supervisorsForClinician() {
        throw new Error("registry unreadable");
      },
    });
    await expect(count(input)).rejects.toThrow("registry unreadable");
  });
});
