// GAP-051 - the vendor webhook verifies its HMAC over the bytes the vendor sent, not a re-serialisation.
import { createHmac } from "node:crypto";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import type { PortalRouteDeps } from "../routes/index";
import { registerTelehealthRoutes } from "../routes/telehealth.routes";
import { buildDailyTelehealthAdapter } from "../telehealth/vendor-adapter";

const SECRET = "whsec";
const adapter = buildDailyTelehealthAdapter({
  TELEHEALTH_DAILY_API_KEY: "key",
  TELEHEALTH_DAILY_WEBHOOK_SECRET: SECRET,
  TELEHEALTH_ROOM_NAME_SECRET: "roomsec",
});

async function makeApp() {
  const app = Fastify();
  registerTelehealthRoutes(app, { store: {}, telehealth: adapter } as unknown as PortalRouteDeps);
  await app.ready();
  return app;
}

// Key order and spacing a JSON.parse -> JSON.stringify round trip would NOT reproduce.
const RAW = '{ "type" : "meeting.ended",  "payload":{"b":1,"a":2} }';
const sign = (raw: string) => createHmac("sha256", SECRET).update(raw, "utf8").digest("hex");

describe("telehealth vendor webhook", () => {
  it("accepts a body whose signature was computed over the exact raw bytes", async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/telehealth/webhooks/daily-co",
      headers: { "content-type": "application/json", "x-webhook-signature": sign(RAW) },
      payload: RAW,
    });
    expect(res.statusCode).toBe(200);
  });

  it("rejects a wrong signature with 401", async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/telehealth/webhooks/daily-co",
      headers: { "content-type": "application/json", "x-webhook-signature": sign("other") },
      payload: RAW,
    });
    expect(res.statusCode).toBe(401);
  });
});
