// The dev-only M34 provision gateway stub must satisfy the REAL client in provision-gateway.ts (the contract's
// authority), so these tests drive createM34ProvisionGateway against the stub's handler with no network.
import { describe, expect, it } from "vitest";
import { createM34ProvisionGateway } from "../../apps/backend/src/modules/34-saas-tenant-platform/provision-gateway";
import { handleGatewayRequest } from "../dev/m34-provision-gateway";

const TOKEN = "dev-gateway-token-0123456789abcdef";
const config = {
  baseUrl: "http://provision-gateway:8080",
  bearerToken: TOKEN,
  invitationAcceptBaseUrl: "http://localhost:5173/invite",
  timeoutMs: 5000,
};

function clientAgainstStub(logged: string[] = [], token = TOKEN) {
  return createM34ProvisionGateway(config, {
    async request({ path, body, config: cfg }) {
      return handleGatewayRequest(
        { path, body, authorization: `Bearer ${cfg.bearerToken}` },
        { token, log: (line) => logged.push(line) },
      );
    },
  });
}

describe("dev M34 provision gateway stub", () => {
  it("confirms every requested storage prefix", async () => {
    const out = await clientAgainstStub().storage.ensureTenantPrefixes({
      organizationId: "org-1",
      prefixes: ["tenant-org-1/documents/", "tenant-org-1/claims/"],
    });
    expect(out.prefixesEnsured).toEqual(["tenant-org-1/documents/", "tenant-org-1/claims/"]);
  });

  it("accepts an invitation and logs the accept link for the dev operator", async () => {
    const logged: string[] = [];
    await expect(
      clientAgainstStub(logged).invitation.send({
        to: "admin@sunrisehospice.local",
        inviteeFullName: "Sunrise Admin",
        invitationUrl: "http://localhost:5173/invite/raw-token",
        expiresAt: new Date("2030-01-01T00:00:00Z"),
      }),
    ).resolves.toBeUndefined();
    expect(logged.join("\n")).toContain("http://localhost:5173/invite/raw-token");
  });

  it("rejects a wrong bearer token with 401", async () => {
    const res = await handleGatewayRequest(
      { path: "/notifications/tenant-invitation", body: {}, authorization: "Bearer nope" },
      { token: TOKEN, log: () => {} },
    );
    expect(res.status).toBe(401);
  });

  it("rejects a malformed invitation body with 400", async () => {
    const res = await handleGatewayRequest(
      {
        path: "/notifications/tenant-invitation",
        body: { to: 1 },
        authorization: `Bearer ${TOKEN}`,
      },
      { token: TOKEN, log: () => {} },
    );
    expect(res.status).toBe(400);
  });

  it.each(["/dek/wrap", "/dek/unwrap", "/storage/tenant-scope/destroy"] as const)(
    "refuses %s with 501 rather than faking it",
    async (path) => {
      const res = await handleGatewayRequest(
        { path, body: {}, authorization: `Bearer ${TOKEN}` },
        { token: TOKEN, log: () => {} },
      );
      expect(res.status).toBe(501);
    },
  );

  it("answers 404 for an unknown path", async () => {
    const res = await handleGatewayRequest(
      { path: "/nope", body: {}, authorization: `Bearer ${TOKEN}` },
      { token: TOKEN, log: () => {} },
    );
    expect(res.status).toBe(404);
  });
});
