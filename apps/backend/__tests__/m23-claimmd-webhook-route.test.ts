// M23 Claim.MD webhook ingress (ADR-0053 amendment D7): the route and its configuration, with the store faked. The
// database half (atomic batch, dedupe, encryption, RLS) is proved in m23-claimmd-webhook.live.test.ts.
import { createHmac } from "node:crypto";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { applyErrorHandler } from "../src/bootstrap/plugins/error-handler";
import { claimMdWebhookConfigFromEnv } from "../src/modules/23-billing-medicare/claimmd-webhook/config";
import type { ClaimMdReceive } from "../src/modules/23-billing-medicare/claimmd-webhook/receipt-store";
import { registerClaimMdWebhookRoutes } from "../src/modules/23-billing-medicare/claimmd-webhook/routes";

const KEY = "SYNTH99999_k#ey*not-real";
const BODY = '{"acct_number":"99999","events":[{"eventid":"1","event_type":"test"}]}';
const sign = (body: string | Buffer, key = KEY) =>
  createHmac("sha256", Buffer.from(key, "latin1")).update(body).digest("base64");

function harness(bound = true) {
  const calls: Buffer[] = [];
  const receive: ClaimMdReceive = async ({ rawBody }) => {
    calls.push(rawBody);
    return 1;
  };
  const app = Fastify();
  applyErrorHandler(app);
  registerClaimMdWebhookRoutes(app, {
    binding: bound ? { usage: "test", accountKey: KEY, receive } : null,
    usage: "test",
  });
  return { app, calls };
}

const post = (url: string, body: string, headers: Record<string, string>) => ({
  method: "POST" as const,
  url,
  payload: body,
  headers: { "content-type": "application/json", ...headers },
});

describe("POST /api/v1/webhooks/claimmd/<usage>", () => {
  it("stores the exact signed bytes and answers 200 with the count", async () => {
    const { app, calls } = harness();
    const body = `${BODY}\n`; // a trailing newline: the HMAC covers it, a re-serialised body would not
    const res = await app.inject(
      post("/api/v1/webhooks/claimmd/test", body, { "auth-signature-base64": sign(body) }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: 1 });
    expect(calls[0]?.toString("utf8")).toBe(body);
  });

  it("verifies a body sent under any content type, still as bytes", async () => {
    const { app, calls } = harness();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/webhooks/claimmd/test",
      payload: BODY,
      headers: {
        "content-type": "text/plain; charset=latin1",
        "auth-signature-base64": sign(BODY),
      },
    });
    expect(res.statusCode).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it("answers the same 401 for a missing, malformed, repeated or wrong signature, storing nothing", async () => {
    const { app, calls } = harness();
    const url = "/api/v1/webhooks/claimmd/test";
    const cases: Record<string, string>[] = [
      {},
      { "auth-signature-base64": "not-base64" },
      { "auth-signature-base64": sign(BODY, "SYNTH_other_key") },
      { "auth-signature-base64": sign(`${BODY} `) },
    ];
    for (const headers of cases) {
      const res = await app.inject(post(url, BODY, headers));
      expect(res.statusCode).toBe(401);
      expect(res.json().code ?? res.json().error?.code).toBe("INVALID_SIGNATURE");
    }
    const repeated = await app.inject({
      method: "POST",
      url,
      payload: BODY,
      headers: {
        "content-type": "application/json",
        "auth-signature-base64": [sign(BODY), sign(BODY)],
      },
    });
    expect(repeated.statusCode).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("mounts only the configured usage", async () => {
    const { app } = harness();
    const res = await app.inject(
      post("/api/v1/webhooks/claimmd/production", BODY, { "auth-signature-base64": sign(BODY) }),
    );
    expect(res.statusCode).toBe(404);
  });

  it("answers 413 above 1 MiB without calling the store", async () => {
    const { app, calls } = harness();
    const big = "x".repeat(1024 * 1024 + 1);
    const res = await app.inject(
      post("/api/v1/webhooks/claimmd/test", big, { "auth-signature-base64": sign(big) }),
    );
    expect(res.statusCode).toBe(413);
    expect(calls).toHaveLength(0);
  });

  it("answers 503 when unconfigured, before reading the body", async () => {
    const { app } = harness(false);
    const res = await app.inject(
      post("/api/v1/webhooks/claimmd/test", "{", { "auth-signature-base64": sign("{") }),
    );
    expect(res.statusCode).toBe(503);
    expect(JSON.stringify(res.json())).toContain("CLAIMMD_WEBHOOK_UNCONFIGURED");
  });
});

describe("claimMdWebhookConfigFromEnv", () => {
  const runner = (async () => undefined) as never;
  const env = {
    CLAIMMD_WEBHOOK_ENABLED: "true",
    CLAIMMD_ACCOUNT_KEY: KEY,
    CLAIMMD_ACCOUNT_USAGE: "test",
    CLAIMMD_WEBHOOK_PAYLOAD_KEY: Buffer.alloc(32, 3).toString("base64"),
  };

  it("is off unless exactly enabled", () => {
    expect(
      claimMdWebhookConfigFromEnv({ ...env, CLAIMMD_WEBHOOK_ENABLED: "1" }, runner),
    ).toMatchObject({
      bound: null,
      missing: [],
      usage: "test",
    });
  });

  it("names every missing prerequisite and binds nothing", () => {
    expect(
      claimMdWebhookConfigFromEnv({ CLAIMMD_WEBHOOK_ENABLED: "true" }, undefined).missing,
    ).toEqual([
      "CLAIMMD_ACCOUNT_KEY",
      "CLAIMMD_ACCOUNT_USAGE",
      "CLAIMMD_WEBHOOK_PAYLOAD_KEY",
      "DATABASE_PLATFORM_URL",
    ]);
  });

  it("binds when everything is present and refuses a short payload key", () => {
    expect(claimMdWebhookConfigFromEnv(env, runner).bound?.usage).toBe("test");
    expect(() =>
      claimMdWebhookConfigFromEnv(
        { ...env, CLAIMMD_WEBHOOK_PAYLOAD_KEY: Buffer.alloc(8).toString("base64") },
        runner,
      ),
    ).toThrow(/32 bytes/);
  });
});
