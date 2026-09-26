import { describe, expect, it } from "vitest";
import { createM34ProvisionGateway } from "./provision-gateway";

const config = {
  baseUrl: "https://provision.invalid",
  bearerToken: "secret-token",
  invitationAcceptBaseUrl: "https://app.invalid/tenant-invitations",
  timeoutMs: 5000,
};

describe("M34 provision gateway", () => {
  it("requires confirmation of every storage prefix", async () => {
    const gateway = createM34ProvisionGateway(config, {
      async request(input) {
        return input.path === "/storage/tenant-prefixes"
          ? { status: 200, body: { prefixesEnsured: ["documents"] } }
          : { status: 200, body: { accepted: true } };
      },
    });
    await expect(
      gateway.storage.ensureTenantPrefixes({
        organizationId: "org-1",
        prefixes: ["documents", "claims"],
      }),
    ).rejects.toThrow("did not confirm every required storage prefix");
  });

  it("returns wrapped key material without exposing gateway response details", async () => {
    const gateway = createM34ProvisionGateway(config, {
      request: async () => ({
        status: 200,
        body: { wrappedCiphertextB64: "Y2lwaGVydGV4dA==", kekId: "kms-key-1" },
      }),
    });
    await expect(gateway.keyMaterial.mintAndWrapDek({ organizationId: "org-1" })).resolves.toEqual({
      wrappedCiphertextB64: "Y2lwaGVydGV4dA==",
      kekId: "kms-key-1",
    });
  });

  it("unwraps only a 256-bit DEK", async () => {
    const plaintext = Buffer.alloc(32, 7);
    const gateway = createM34ProvisionGateway(config, {
      request: async () => ({
        status: 200,
        body: { plaintextDekB64: plaintext.toString("base64") },
      }),
    });
    await expect(
      gateway.kekUnwrap.unwrap({
        organizationId: "org-1",
        kekWrappedCiphertext: Buffer.from("wrapped"),
        kekId: "kek-1",
      }),
    ).resolves.toEqual(plaintext);
  });

  it("rejects malformed unwrapped key material", async () => {
    const gateway = createM34ProvisionGateway(config, {
      request: async () => ({
        status: 200,
        body: { plaintextDekB64: Buffer.alloc(16).toString("base64") },
      }),
    });
    await expect(
      gateway.kekUnwrap.unwrap({
        organizationId: "org-1",
        kekWrappedCiphertext: Buffer.from("wrapped"),
        kekId: "kek-1",
      }),
    ).rejects.toThrow("not 256 bits");
  });

  it("requires an exact tenant-prefix destruction receipt", async () => {
    const requests: unknown[] = [];
    const gateway = createM34ProvisionGateway(config, {
      request: async (input) => {
        requests.push(input.body);
        return {
          status: 200,
          body:
            input.path === "/storage/tenant-scope/destroy"
              ? { prefix: "tenant-another-org/", objectsDeleted: 4 }
              : { accepted: true },
        };
      },
    });
    await expect(
      gateway.destructionStorage.destroyTenantScope({ organizationId: "org-1" }),
    ).rejects.toThrow("invalid storage destruction receipt");
    expect(requests[0]).toMatchObject({ expectedPrefix: "tenant-org-1/" });
  });
});
