// GAP-051 - the Daily.co adapter is bound from config and bridged to the route port against a fake vendor.
import { createHmac } from "node:crypto";
import { DailyCoTelehealthProvider, type FetchLike } from "@wardenx/telehealth-client";
import { describe, expect, it } from "vitest";
import {
  TELEHEALTH_PARTICIPANT_TOKEN_TTL_SECONDS,
  buildDailyTelehealthAdapter,
  toTelehealthAdapterPort,
} from "../telehealth/vendor-adapter";

const VISIT = "55555555-5555-4555-8555-555555555555";
const FULL_ENV = {
  TELEHEALTH_DAILY_API_KEY: "key",
  TELEHEALTH_DAILY_WEBHOOK_SECRET: "whsec",
  TELEHEALTH_ROOM_NAME_SECRET: "roomsec",
};

interface Call {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
}

function fakeVendor() {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(init.body) : undefined,
    });
    if (url.includes("/meeting-tokens"))
      return { ok: true, status: 200, json: async () => ({ token: "tok" }) };
    if (init?.method === "POST" && url.endsWith("/rooms")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ name: "n", url: "https://d.example/n" }),
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const provider = new DailyCoTelehealthProvider({
    endpoint: "https://api.daily.test/v1",
    apiKey: "key",
    roomNameSecret: "roomsec",
    webhookSecret: "whsec",
    now: () => "2026-10-08T12:00:00.000Z",
    fetchImpl,
  });
  return { calls, provider };
}

describe("buildDailyTelehealthAdapter", () => {
  it("stays unbound (undefined) unless every secret is configured", () => {
    expect(buildDailyTelehealthAdapter({})).toBeUndefined();
    expect(
      buildDailyTelehealthAdapter({ ...FULL_ENV, TELEHEALTH_DAILY_API_KEY: " " }),
    ).toBeUndefined();
    expect(
      buildDailyTelehealthAdapter({ ...FULL_ENV, TELEHEALTH_ROOM_NAME_SECRET: undefined }),
    ).toBeUndefined();
  });

  it("binds a daily_co adapter when fully configured", () => {
    const adapter = buildDailyTelehealthAdapter(FULL_ENV);
    expect(adapter?.vendor).toBe("daily_co");
    expect(typeof adapter?.mintRoom).toBe("function");
  });
});

describe("toTelehealthAdapterPort", () => {
  it("addresses the participant token to the room the visit minted, role mapped to the owner flag", async () => {
    const { calls, provider } = fakeVendor();
    const port = toTelehealthAdapterPort(provider);

    const minted = await port.mintParticipantToken({ telehealthVisitId: VISIT, role: "clinician" });

    expect(minted.token).toBe("tok");
    const tokenCall = calls.find((c) => c.url.endsWith("/meeting-tokens"));
    const props = (tokenCall?.body as { properties: { room_name: string; is_owner: boolean } })
      .properties;
    expect(props.room_name).toBe(provider.roomNameForVisit(VISIT));
    expect(props.room_name).toMatch(/^tlh_[0-9a-f]{32}$/);
    expect(props.room_name).not.toContain(VISIT);
    expect(props.is_owner).toBe(true);
    expect(TELEHEALTH_PARTICIPANT_TOKEN_TTL_SECONDS).toBeGreaterThanOrEqual(1_800);
  });

  it("verifies the vendor webhook HMAC over the raw body", () => {
    const { provider } = fakeVendor();
    const port = toTelehealthAdapterPort(provider);
    const raw = '{"type":"meeting.ended"}';
    const signature = createHmac("sha256", "whsec").update(raw, "utf8").digest("hex");

    expect(port.verifyWebhookSignature({ "x-webhook-signature": signature }, raw)).toBe(true);
    expect(port.verifyWebhookSignature({ "x-webhook-signature": signature }, `${raw} `)).toBe(
      false,
    );
    expect(port.verifyWebhookSignature({}, raw)).toBe(false);
  });
});
