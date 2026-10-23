// ADR-0096 D17 - the per-address budgets of the partner routes are keyed on `request.ip`. Fastify derives it from the socket peer unless the peer is one
// of TRUSTED_PROXY_CIDRS (bootstrap/index.ts). Proved here with real inject: a spoofed X-Forwarded-For from an UNTRUSTED peer does not move the key, one
// from a TRUSTED peer does. Also: the availability rule and the "partner routes are not mounted" mode.
import { afterEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { partnerAccessAvailability } from "../src/modules/36-messaging/external-share/external-share-proxy";
import type { ExternalShareService } from "../src/modules/36-messaging/external-share/external-share-service";
import { registerExternalShareRoutes } from "../src/modules/36-messaging/routes/external-share-routes";

const ORG = "11111111-1111-4111-8111-111111111111";
const TOKEN = "A".repeat(43);

function build(trusted: string | undefined, partnerRoutes?: boolean) {
  const seen: string[] = [];
  const previous = process.env.TRUSTED_PROXY_CIDRS;
  if (trusted === undefined) Reflect.deleteProperty(process.env, "TRUSTED_PROXY_CIDRS");
  else process.env.TRUSTED_PROXY_CIDRS = trusted;
  const server = buildServer({ security: { rateLimitEnabled: false } });
  if (previous === undefined) Reflect.deleteProperty(process.env, "TRUSTED_PROXY_CIDRS");
  else process.env.TRUSTED_PROXY_CIDRS = previous;
  const service = {
    redeem: async (_input: unknown, meta: { ip: string }) => {
      seen.push(meta.ip);
      return {
        sessionToken: "x",
        shareId: ORG,
        stage: "enrolment",
        expiresAt: new Date().toISOString(),
      };
    },
  } as unknown as ExternalShareService;
  registerExternalShareRoutes(server, {
    service,
    ...(partnerRoutes === undefined ? {} : { partnerRoutes }),
  });
  return { server, seen };
}

const redeem = (server: ReturnType<typeof build>["server"], remoteAddress: string, xff?: string) =>
  server.inject({
    method: "POST",
    url: "/api/v1/messaging/partner/redeem",
    remoteAddress,
    headers: xff ? { "x-forwarded-for": xff } : {},
    payload: { organizationId: ORG, token: TOKEN },
  });

let open: Array<{ close: () => Promise<unknown> }> = [];
afterEach(async () => {
  await Promise.all(open.map((s) => s.close()));
  open = [];
});

describe("request.ip behind (or without) a trusted proxy", () => {
  it("UNTRUSTED peer: a spoofed X-Forwarded-For does not change the budget key", async () => {
    const { server, seen } = build(undefined);
    open.push(server);
    const res = await redeem(server, "203.0.113.9", "1.2.3.4");
    expect(res.statusCode).toBe(200);
    expect(seen).toEqual(["203.0.113.9"]);
  });

  it("a peer that is not in TRUSTED_PROXY_CIDRS is untrusted even when other hops are", async () => {
    const { server, seen } = build("10.0.0.0/8");
    open.push(server);
    await redeem(server, "203.0.113.9", "1.2.3.4");
    expect(seen).toEqual(["203.0.113.9"]);
  });

  it("TRUSTED peer: the forwarded client address is the key", async () => {
    const { server, seen } = build("10.0.0.0/8");
    open.push(server);
    await redeem(server, "10.0.0.5", "198.51.100.7");
    expect(seen).toEqual(["198.51.100.7"]);
  });

  it("TRUSTED peer: a client-supplied extra hop in the header cannot pick the key (the proxy's own appended address wins)", async () => {
    const { server, seen } = build("10.0.0.0/8");
    open.push(server);
    await redeem(server, "10.0.0.5", "9.9.9.9, 198.51.100.7");
    expect(seen).toEqual(["198.51.100.7"]);
  });
});

describe("partner routes not mounted (production without TRUSTED_PROXY_CIDRS)", () => {
  it("the partner routes answer the framework 404, never reaching the service", async () => {
    const { server, seen } = build(undefined, false);
    open.push(server);
    const res = await redeem(server, "203.0.113.9");
    expect(res.statusCode).toBe(404);
    expect(seen).toEqual([]);
  });
});

describe("partnerAccessAvailability", () => {
  it.each([
    [{ NODE_ENV: "production", TRUSTED_PROXY_CIDRS: undefined }, false],
    [{ NODE_ENV: "production", TRUSTED_PROXY_CIDRS: "" }, false],
    [{ NODE_ENV: "production", TRUSTED_PROXY_CIDRS: " , ," }, false],
    [{ NODE_ENV: "production", TRUSTED_PROXY_CIDRS: "10.0.0.0/8" }, true],
    [{ NODE_ENV: "development", TRUSTED_PROXY_CIDRS: undefined }, true],
    [{ NODE_ENV: "test", TRUSTED_PROXY_CIDRS: "" }, true],
    [{ NODE_ENV: undefined, TRUSTED_PROXY_CIDRS: undefined }, true],
  ])("%j => available %s", (env, available) => {
    const out = partnerAccessAvailability(env);
    expect(out.available).toBe(available);
    expect(out.warning === null).toBe(available);
  });

  it("the boot warning is one clear line that names the variable and carries no secret", () => {
    const out = partnerAccessAvailability({ NODE_ENV: "production" });
    expect(out.warning).toContain("TRUSTED_PROXY_CIDRS");
    expect(out.warning).toContain("PARTNER_ACCESS_UNAVAILABLE");
    expect(out.warning?.includes("\n")).toBe(false);
  });
});
